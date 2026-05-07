// ---------------------------------------------------------------------------
// Per-session latency log file.
//
// Receives a `LatencyEntry` from the client (via `flushLatencyToFile` in
// `lib/debug.ts`) and persists `session-<startTime>-<sessionIdShort>.log`.
// Two backends:
//   • Local dev (NODE_ENV !== "production"): writes to ./logs on disk.
//   • Vercel (NODE_ENV === "production"): writes a PUBLIC blob via the
//     @vercel/blob SDK. Public URLs are unguessable but anyone with the
//     URL can read — fine for dev observability, do NOT widen.
//
// Layout per file (identical across backends):
//   ┌─ SESSION header (start time, sessionId)
//   ├─ RUNNING SUMMARY (per-segment averages + max, rebuilt each turn)
//   └─ TURN blocks, oldest → newest
//
// In-memory cache: `Map<sessionId, CachedSession>` keyed off the client's
// stable sessionId. In dev it survives the dev-server lifecycle. On Vercel
// it survives within a single lambda instance — instance churn between
// turns of the same session is handled by downloading the existing blob,
// appending the new turn, and re-uploading (no summary recompute since we
// don't ship structured data alongside the formatted text).
//
// Discoverability:
//   • POST returns the persisted URL/path in JSON so the client can echo it.
//   • In prod, the URL is also `console.log`'d on first write so it shows
//     up in Vercel runtime logs.
//   • GET returns the newest 10 sessions as a JSON list so a debug UI (or
//     `curl /api/log-latency`) can find them.
//
// Retention: prunes to the newest 10 `session-*.log` entries on each new
// session start (in dev: file mtime; in prod: blob `uploadedAt`).
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { put as blobPut, list as blobList, del as blobDel } from "@vercel/blob"
import type { LatencyEntry } from "@/lib/debug"

const IS_PROD = process.env.NODE_ENV === "production"
const LOG_DIR = path.join(process.cwd(), "logs")
const MAX_SESSION_FILES = 10
const FILE_PREFIX = "session-"
const FILE_SUFFIX = ".log"
// Bar chart calibration. Each character ≈ 50 ms, capped at 40 chars so even
// a 10-second LLM call doesn't blow the column out. Tweak per taste.
const BAR_MS_PER_CHAR = 50
const BAR_MAX_CHARS = 40

type CachedSession = {
  /** Pathname (also used as blob name in prod) — `session-<stamp>-<shortId>.log`. */
  pathname: string
  /** Public URL of the blob in prod; null in dev (file lives on local disk). */
  blobUrl: string | null
  startedMs: number
  entries: LatencyEntry[]
}

/**
 * Per-sessionId cache of all entries we've seen. In dev it survives the
 * dev-server lifecycle; in prod it survives the lambda instance. Module
 * scope so it's shared across requests.
 */
const SESSION_CACHE = new Map<string, CachedSession>()

export async function POST(request: Request) {
  let entry: LatencyEntry
  try {
    entry = (await request.json()) as LatencyEntry
  } catch {
    return new NextResponse(null, { status: 400 })
  }

  if (!entry || typeof entry !== "object") {
    return new NextResponse(null, { status: 400 })
  }

  try {
    const result = IS_PROD ? await writeProd(entry) : await writeDev(entry)
    return NextResponse.json(result)
  } catch (err) {
    // Never break the user-facing flow — log and swallow.
    // eslint-disable-next-line no-console
    console.error("[log-latency] write failed", err)
    return new NextResponse(null, { status: 500 })
  }
}

/**
 * GET /api/log-latency
 * Returns the newest 10 session log files as JSON `{ sessions: [{ url, pathname, uploadedAt }] }`
 * so a debug UI (or curl) can find recent runs without trawling Vercel logs.
 */
export async function GET() {
  try {
    if (IS_PROD) {
      const blobs = await blobList({ prefix: FILE_PREFIX })
      const logs = blobs.blobs
        .filter((b) => b.pathname.endsWith(FILE_SUFFIX))
        .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
        .slice(0, MAX_SESSION_FILES)
        .map((b) => ({
          url: b.url,
          pathname: b.pathname,
          uploadedAt: b.uploadedAt,
          size: b.size,
        }))
      return NextResponse.json({ sessions: logs })
    }

    await fs.mkdir(LOG_DIR, { recursive: true })
    const files = await fs.readdir(LOG_DIR)
    const sessionFiles = files.filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
    const withMtime = await Promise.all(
      sessionFiles.map(async (f) => {
        const stat = await fs.stat(path.join(LOG_DIR, f))
        return { pathname: f, uploadedAt: new Date(stat.mtimeMs).toISOString(), size: stat.size }
      }),
    )
    withMtime.sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
    return NextResponse.json({ sessions: withMtime.slice(0, MAX_SESSION_FILES) })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[log-latency] list failed", err)
    return NextResponse.json({ sessions: [] }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Dev backend: filesystem
// ---------------------------------------------------------------------------

async function writeDev(entry: LatencyEntry): Promise<{ ok: true; pathname: string }> {
  await fs.mkdir(LOG_DIR, { recursive: true })
  const sessionId = entry.sessionId ?? "unknown"
  const cached = await getOrInitCachedSessionDev(sessionId, entry)

  if (cached === null) {
    // Server restarted mid-session — file already on disk, cache empty.
    // Degrade to plain append so we don't clobber prior turns or
    // partially-rebuild a misleading summary.
    const pathname = await resolveSessionPathnameDev(entry)
    const block = formatTurnBlock(entry)
    const footer =
      "  (note: dev-server restarted mid-session — running summary above does not include this turn)\n"
    await fs.appendFile(path.join(LOG_DIR, pathname), block + footer, "utf8")
    return { ok: true, pathname }
  }

  cached.entries.push(entry)
  const content = formatFullSessionFile(cached)
  await fs.writeFile(path.join(LOG_DIR, cached.pathname), content, "utf8")
  return { ok: true, pathname: cached.pathname }
}

async function getOrInitCachedSessionDev(
  sessionId: string,
  entry: LatencyEntry,
): Promise<CachedSession | null> {
  const existing = SESSION_CACHE.get(sessionId)
  if (existing) return existing

  const shortId = sessionId.slice(0, 8)
  const onDisk = await findExistingSessionFileDev(shortId)
  if (onDisk) return null

  const startedMs = entry.ts ?? Date.now()
  const stamp = formatStampForFilename(startedMs)
  const pathname = `${FILE_PREFIX}${stamp}-${shortId}${FILE_SUFFIX}`
  const cached: CachedSession = { pathname, blobUrl: null, startedMs, entries: [] }
  SESSION_CACHE.set(sessionId, cached)
  await pruneOldSessionsDev()
  return cached
}

async function resolveSessionPathnameDev(entry: LatencyEntry): Promise<string> {
  const sessionId = entry.sessionId ?? "unknown"
  const shortId = sessionId.slice(0, 8)
  const existing = await findExistingSessionFileDev(shortId)
  if (existing) return existing
  const stamp = formatStampForFilename(entry.ts ?? Date.now())
  return `${FILE_PREFIX}${stamp}-${shortId}${FILE_SUFFIX}`
}

async function findExistingSessionFileDev(shortId: string): Promise<string | null> {
  try {
    const files = await fs.readdir(LOG_DIR)
    return (
      files.find((f) => f.startsWith(FILE_PREFIX) && f.endsWith(`-${shortId}${FILE_SUFFIX}`)) ??
      null
    )
  } catch {
    return null
  }
}

async function pruneOldSessionsDev(): Promise<void> {
  try {
    const files = await fs.readdir(LOG_DIR)
    const sessionFiles = files.filter(
      (f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX),
    )
    if (sessionFiles.length <= MAX_SESSION_FILES) return

    const withMtime = await Promise.all(
      sessionFiles.map(async (f) => ({
        name: f,
        mtime: (await fs.stat(path.join(LOG_DIR, f))).mtimeMs,
      })),
    )
    withMtime.sort((a, b) => b.mtime - a.mtime)
    const toDelete = withMtime.slice(MAX_SESSION_FILES)
    await Promise.all(
      toDelete.map((f) => fs.unlink(path.join(LOG_DIR, f.name)).catch(() => undefined)),
    )
  } catch {
    // Pruning is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Prod backend: Vercel Blob
// ---------------------------------------------------------------------------

async function writeProd(
  entry: LatencyEntry,
): Promise<{ ok: true; url: string; pathname: string }> {
  const sessionId = entry.sessionId ?? "unknown"
  const cached = await getOrInitCachedSessionProd(sessionId, entry)

  if (cached === null) {
    // Lambda instance churn — the blob exists from a previous instance but
    // we don't have its entries in memory. Download, append, re-upload,
    // and add a footer note. No summary recompute since we don't ship a
    // structured sidecar.
    const shortId = sessionId.slice(0, 8)
    const existing = await findExistingSessionBlob(shortId)
    if (!existing) {
      // Race: blob disappeared between findExistingSessionBlob calls.
      // Fall through to fresh-session creation.
      return startFreshProdSession(sessionId, entry)
    }
    const prior = await fetch(existing.url).then((r) => r.text()).catch(() => "")
    const block = formatTurnBlock(entry)
    const footer =
      "  (note: lambda instance changed mid-session — running summary above does not include this turn)\n"
    const content = prior + block + footer
    const result = await blobPut(existing.pathname, content, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "text/plain; charset=utf-8",
    })
    return { ok: true, url: result.url, pathname: existing.pathname }
  }

  cached.entries.push(entry)
  const content = formatFullSessionFile(cached)
  const result = await blobPut(cached.pathname, content, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "text/plain; charset=utf-8",
  })
  // Record the URL the first time we write so we can return it on retry
  // and so the lambda-churn path can find it via list().
  if (!cached.blobUrl) {
    cached.blobUrl = result.url
    // eslint-disable-next-line no-console
    console.log(`[log-latency] session log: ${result.url}`)
  }
  return { ok: true, url: result.url, pathname: cached.pathname }
}

async function startFreshProdSession(
  sessionId: string,
  entry: LatencyEntry,
): Promise<{ ok: true; url: string; pathname: string }> {
  const shortId = sessionId.slice(0, 8)
  const startedMs = entry.ts ?? Date.now()
  const stamp = formatStampForFilename(startedMs)
  const pathname = `${FILE_PREFIX}${stamp}-${shortId}${FILE_SUFFIX}`
  const cached: CachedSession = { pathname, blobUrl: null, startedMs, entries: [entry] }
  SESSION_CACHE.set(sessionId, cached)
  await pruneOldSessionsBlob()
  const content = formatFullSessionFile(cached)
  const result = await blobPut(pathname, content, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "text/plain; charset=utf-8",
  })
  cached.blobUrl = result.url
  // eslint-disable-next-line no-console
  console.log(`[log-latency] session log: ${result.url}`)
  return { ok: true, url: result.url, pathname }
}

async function getOrInitCachedSessionProd(
  sessionId: string,
  entry: LatencyEntry,
): Promise<CachedSession | null> {
  const existing = SESSION_CACHE.get(sessionId)
  if (existing) return existing

  const shortId = sessionId.slice(0, 8)
  const blob = await findExistingSessionBlob(shortId)
  if (blob) {
    // Lambda churn: known sessionId, blob exists, no in-memory entries.
    // Caller falls back to download-and-append.
    return null
  }

  // Fresh session in this lambda instance and on the blob store.
  const startedMs = entry.ts ?? Date.now()
  const stamp = formatStampForFilename(startedMs)
  const pathname = `${FILE_PREFIX}${stamp}-${shortId}${FILE_SUFFIX}`
  const cached: CachedSession = { pathname, blobUrl: null, startedMs, entries: [] }
  SESSION_CACHE.set(sessionId, cached)
  await pruneOldSessionsBlob()
  return cached
}

async function findExistingSessionBlob(
  shortId: string,
): Promise<{ url: string; pathname: string } | null> {
  try {
    const blobs = await blobList({ prefix: FILE_PREFIX })
    const match = blobs.blobs.find((b) =>
      b.pathname.startsWith(FILE_PREFIX) && b.pathname.endsWith(`-${shortId}${FILE_SUFFIX}`),
    )
    return match ? { url: match.url, pathname: match.pathname } : null
  } catch {
    return null
  }
}

async function pruneOldSessionsBlob(): Promise<void> {
  try {
    const blobs = await blobList({ prefix: FILE_PREFIX })
    const logs = blobs.blobs.filter((b) => b.pathname.endsWith(FILE_SUFFIX))
    if (logs.length <= MAX_SESSION_FILES) return
    logs.sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
    const toDelete = logs.slice(MAX_SESSION_FILES)
    await Promise.all(toDelete.map((b) => blobDel(b.url).catch(() => undefined)))
  } catch {
    // Pruning is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Full-file formatter — rewritten on every turn
// ---------------------------------------------------------------------------

function formatFullSessionFile(cached: CachedSession): string {
  const parts: string[] = []
  parts.push(formatSessionHeader(cached))
  parts.push(formatSessionSummary(cached))
  for (const entry of cached.entries) {
    parts.push(formatTurnBlock(entry))
  }
  return parts.join("")
}

function formatSessionHeader(cached: CachedSession): string {
  const sessionId = cached.entries[0]?.sessionId ?? "unknown"
  const started = formatHumanTimestamp(cached.startedMs)
  return [
    "================================================================================",
    `SESSION START  ·  ${started}`,
    `sessionId=${sessionId}`,
    "================================================================================",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Running summary
// ---------------------------------------------------------------------------

const SEGMENT_KEYS = [
  "stt",
  "intent",
  "preflight",
  "netIn",
  "preLlm",
  "llm",
  "postLlm",
  "netOut",
  "repeat",
  "tts",
  "total",
] as const

type SegmentKey = (typeof SEGMENT_KEYS)[number]

function segmentLabel(key: SegmentKey): string {
  switch (key) {
    case "stt": return "STT finalization (HeyGen)"
    case "intent": return "Intent classify (regex)"
    case "preflight": return "Client preflight"
    case "netIn": return "Network  → server"
    case "preLlm": return "Server pre-LLM"
    case "llm": return "LLM call"
    case "postLlm": return "Server post-LLM"
    case "netOut": return "Network  ← server"
    case "repeat": return "repeat() dispatch"
    case "tts": return "HeyGen TTS first audio"
    case "total": return "TOTAL  (user-speak-end → audio)"
  }
}

function extractSegments(entry: LatencyEntry): Record<SegmentKey, number | null> {
  const w = entry.walltimes
  const s = entry.serverTimings
  return {
    stt: deltaPair(w?.userSpeakEnded, w?.userTranscription),
    intent: deltaPair(w?.userTranscription, w?.intentClassified),
    preflight: deltaPair(w?.intentClassified, w?.orchestrateRequestSent),
    netIn: deltaPair(w?.orchestrateRequestSent, s?.requestReceived),
    preLlm: deltaPair(s?.requestReceived, s?.llmCallStart),
    llm: deltaPair(s?.llmCallStart, s?.llmCallEnd),
    postLlm: deltaPair(s?.llmCallEnd, s?.responseSent),
    netOut: deltaPair(s?.responseSent, w?.orchestrateResponseReceived),
    repeat: deltaPair(w?.orchestrateResponseReceived, w?.repeatCalled),
    tts: deltaPair(w?.repeatCalled, w?.avatarSpeakStarted),
    total:
      deltaPair(w?.userSpeakEnded, w?.avatarSpeakStarted) ??
      deltaPair(w?.userTranscription, w?.avatarSpeakStarted),
  }
}

function formatSessionSummary(cached: CachedSession): string {
  const entries = cached.entries
  if (entries.length === 0) return ""

  const stats = new Map<SegmentKey, { sum: number; max: number; count: number }>()
  for (const key of SEGMENT_KEYS) stats.set(key, { sum: 0, max: 0, count: 0 })
  for (const entry of entries) {
    const segs = extractSegments(entry)
    for (const key of SEGMENT_KEYS) {
      const v = segs[key]
      if (v === null || !Number.isFinite(v)) continue
      const bucket = stats.get(key)!
      bucket.sum += v
      bucket.count += 1
      if (v > bucket.max) bucket.max = v
    }
  }

  const presentRows: { key: SegmentKey; label: string; avg: number; max: number; count: number }[] = []
  for (const key of SEGMENT_KEYS) {
    const bucket = stats.get(key)!
    if (bucket.count === 0) continue
    presentRows.push({
      key,
      label: segmentLabel(key),
      avg: Math.round(bucket.sum / bucket.count),
      max: bucket.max,
      count: bucket.count,
    })
  }

  const lastUpdated = formatHumanTimestamp(entries[entries.length - 1]?.ts ?? Date.now())
  const lines: string[] = []
  lines.push("================================================================================")
  lines.push(`RUNNING SUMMARY  ·  ${entries.length} turn${entries.length === 1 ? "" : "s"}  ·  last updated ${lastUpdated}`)
  lines.push("--------------------------------------------------------------------------------")

  const labelWidth = Math.max(...presentRows.map((r) => r.label.length))
  for (const row of presentRows) {
    if (row.key === "total") continue
    lines.push(formatSummaryRow(row.label, row.avg, row.max, row.count, entries.length, labelWidth))
  }
  const totalRow = presentRows.find((r) => r.key === "total")
  if (totalRow) {
    lines.push(`  ${" ".repeat(labelWidth)}     ─────────`)
    lines.push(formatSummaryRow(totalRow.label, totalRow.avg, totalRow.max, totalRow.count, entries.length, labelWidth))
  }

  const slowestNonTotal = presentRows.filter((r) => r.key !== "total").sort((a, b) => b.avg - a.avg)[0]
  if (slowestNonTotal) {
    lines.push("")
    lines.push(`  slowest segment on average: ${slowestNonTotal.label.trim()} (avg ${slowestNonTotal.avg} ms)`)
  }
  lines.push("================================================================================")
  lines.push("")
  return lines.join("\n")
}

function formatSummaryRow(
  label: string,
  avg: number,
  max: number,
  count: number,
  totalTurns: number,
  labelWidth: number,
): string {
  const paddedLabel = label.padEnd(labelWidth, " ")
  const avgStr = `avg ${String(avg).padStart(5, " ")} ms`
  const maxStr = `max ${String(max).padStart(5, " ")} ms`
  const coverage = count < totalTurns ? `  (${count}/${totalTurns} turns)` : ""
  const bar = barFor(avg)
  return `  ${paddedLabel}  ${avgStr}   ${maxStr}${coverage}  ${bar}`.trimEnd()
}

// ---------------------------------------------------------------------------
// Per-turn block
// ---------------------------------------------------------------------------

type Segment = { label: string; ms: number | null }

function formatTurnBlock(entry: LatencyEntry): string {
  const lines: string[] = []
  const turnTs = formatHumanTimestamp(entry.ts ?? Date.now())
  const stage = entry.stage ?? "?"
  const pathway = entry.pathway ?? "?"
  const turnId = entry.turnId ?? "?"
  const userMsg = truncate(entry.msg ?? "", 240)
  const speech = truncate(entry.speech ?? "", 240)

  lines.push("================================================================================")
  lines.push(`TURN  ·  ${turnTs}  ·  stage=${stage}  ·  pathway=${pathway}`)
  lines.push(`turnId=${turnId}`)
  lines.push(`user:   ${quote(userMsg)}`)
  if (speech) lines.push(`avatar: ${quote(speech)}`)

  const segments = computeSegments(entry)
  if (segments.length > 0) {
    lines.push("--------------------------------------------------------------------------------")
    const labelWidth = Math.max(...segments.map((s) => s.label.length))
    for (const seg of segments) {
      lines.push(formatSegmentLine(seg, labelWidth))
    }
    lines.push(`  ${" ".repeat(labelWidth)}     ────────`)
    const total =
      pickFirstFinite(
        deltaUserSpeakEndedToAudio(entry),
        deltaUserTranscriptionToAudio(entry),
      ) ?? null
    if (total !== null) {
      const totalLabel = entry.walltimes?.userSpeakEnded
        ? "TOTAL  (user-speak-end → audio)"
        : "TOTAL  (transcription → audio)"
      lines.push(formatSegmentLine({ label: totalLabel, ms: total }, labelWidth))
    }
    const speechMs = deltaAvatarSpeech(entry)
    if (speechMs !== null) {
      lines.push("")
      lines.push(formatSegmentLine({ label: "Avatar speech duration", ms: speechMs }, labelWidth))
    }
    const provider = entry.serverTimings?.provider
    const model = entry.serverTimings?.model
    if (provider || model) {
      lines.push("")
      lines.push(`  llm: provider=${provider ?? "?"} model=${model ?? "?"}`)
    }
  }

  lines.push("================================================================================")
  lines.push("")
  return lines.join("\n")
}

function computeSegments(entry: LatencyEntry): Segment[] {
  const segs = extractSegments(entry)
  const provider = entry.serverTimings?.provider
  const model = entry.serverTimings?.model
  const llmLabel = `LLM call${provider ? ` (${provider}${model ? " " + model : ""})` : ""}`
  const ordered: Segment[] = [
    { label: "STT finalization (HeyGen)", ms: segs.stt },
    { label: "Intent classify (regex)", ms: segs.intent },
    { label: "Client preflight", ms: segs.preflight },
    { label: "Network  → server", ms: segs.netIn },
    { label: "Server pre-LLM", ms: segs.preLlm },
    { label: llmLabel, ms: segs.llm },
    { label: "Server post-LLM", ms: segs.postLlm },
    { label: "Network  ← server", ms: segs.netOut },
    { label: "repeat() dispatch", ms: segs.repeat },
    { label: "HeyGen TTS first audio", ms: segs.tts },
  ]
  return ordered.filter((seg) => seg.ms !== null)
}

function formatSegmentLine(seg: Segment, labelWidth: number): string {
  const label = seg.label.padEnd(labelWidth, " ")
  const ms = seg.ms === null ? "   —  " : `${String(seg.ms).padStart(5, " ")} ms`
  const bar = seg.ms === null ? "" : barFor(seg.ms)
  return `  ${label}  ${ms}  ${bar}`.trimEnd()
}

function barFor(ms: number): string {
  if (ms <= 0) return ""
  const chars = Math.min(BAR_MAX_CHARS, Math.max(1, Math.round(ms / BAR_MS_PER_CHAR)))
  return "█".repeat(chars)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deltaPair(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a !== "number" || typeof b !== "number") return null
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const d = b - a
  if (d < 0) return null
  return Math.round(d)
}

function deltaUserSpeakEndedToAudio(entry: LatencyEntry): number | null {
  return deltaPair(entry.walltimes?.userSpeakEnded, entry.walltimes?.avatarSpeakStarted)
}

function deltaUserTranscriptionToAudio(entry: LatencyEntry): number | null {
  return deltaPair(entry.walltimes?.userTranscription, entry.walltimes?.avatarSpeakStarted)
}

function deltaAvatarSpeech(entry: LatencyEntry): number | null {
  return deltaPair(entry.walltimes?.avatarSpeakStarted, entry.walltimes?.avatarSpeakEnded)
}

function pickFirstFinite(...values: Array<number | null>): number | null {
  for (const v of values) if (v !== null && Number.isFinite(v)) return v
  return null
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

function quote(s: string): string {
  return s ? `"${s}"` : ""
}

function formatHumanTimestamp(ms: number): string {
  const d = new Date(ms)
  return [
    d.getFullYear(),
    "-",
    pad2(d.getMonth() + 1),
    "-",
    pad2(d.getDate()),
    " ",
    pad2(d.getHours()),
    ":",
    pad2(d.getMinutes()),
    ":",
    pad2(d.getSeconds()),
    ".",
    pad3(d.getMilliseconds()),
  ].join("")
}

function formatStampForFilename(ms: number): string {
  const d = new Date(ms)
  return [
    d.getFullYear(),
    "-",
    pad2(d.getMonth() + 1),
    "-",
    pad2(d.getDate()),
    "_",
    pad2(d.getHours()),
    "-",
    pad2(d.getMinutes()),
    "-",
    pad2(d.getSeconds()),
  ].join("")
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`
  if (n < 100) return `0${n}`
  return String(n)
}
