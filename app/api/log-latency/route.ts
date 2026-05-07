// ---------------------------------------------------------------------------
// Per-session latency log file.
//
// Receives a `LatencyEntry` from the client (via `flushLatencyToFile` in
// `lib/debug.ts`) and rewrites `logs/session-<startTime>-<sessionIdShort>.log`
// each turn so the file always opens to a running summary at the top
// followed by every turn block. Production no-ops: Vercel/serverless
// filesystems are ephemeral and read-only, and this whole system exists for
// local dev observability.
//
// Layout per file:
//   ┌─ SESSION header (start time, sessionId)
//   ├─ RUNNING SUMMARY (per-segment averages + max, rebuilt each turn)
//   └─ TURN blocks, oldest → newest
//
// In-memory cache: `Map<sessionId, CachedSession>` keyed off the client's
// stable sessionId. Survives the dev-server lifecycle but not module
// hot-reloads. On cache miss + an existing file (i.e. server restarted
// mid-session), we degrade to plain append-only — the prior turns and their
// summary stay intact, and a small footer note explains why the summary at
// the top is now stale.
//
// Retention: prunes to the newest 10 `session-*.log` files on each new
// session start.
// ---------------------------------------------------------------------------

import { promises as fs } from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import type { LatencyEntry } from "@/lib/debug"

const LOG_DIR = path.join(process.cwd(), "logs")
const MAX_SESSION_FILES = 10
const FILE_PREFIX = "session-"
const FILE_SUFFIX = ".log"
// Bar chart calibration. Each character ≈ 50 ms, capped at 40 chars so even
// a 10-second LLM call doesn't blow the column out. Tweak per taste.
const BAR_MS_PER_CHAR = 50
const BAR_MAX_CHARS = 40

type CachedSession = {
  filePath: string
  startedMs: number
  entries: LatencyEntry[]
}

/**
 * Per-sessionId cache of all entries we've seen this dev-server lifecycle.
 * Powers the rewrite-the-whole-file approach. Lives at module scope so it
 * survives across requests but is reset on dev-server restart.
 */
const SESSION_CACHE = new Map<string, CachedSession>()

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 204 })
  }

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
    await fs.mkdir(LOG_DIR, { recursive: true })
    const sessionId = entry.sessionId ?? "unknown"
    const cached = await getOrInitCachedSession(sessionId, entry)

    if (cached === null) {
      // Server restarted mid-session — file already on disk, cache empty.
      // Degrade to plain append so we don't clobber prior turns or
      // partially-rebuild a misleading summary.
      const filePath = await resolveSessionFilePath(entry)
      const block = formatTurnBlock(entry)
      const footer =
        "  (note: dev-server restarted mid-session — running summary above does not include this turn)\n"
      await fs.appendFile(filePath, block + footer, "utf8")
      return new NextResponse(null, { status: 204 })
    }

    cached.entries.push(entry)
    const content = formatFullSessionFile(cached)
    await fs.writeFile(cached.filePath, content, "utf8")
  } catch (err) {
    // Never break the user-facing flow — log and swallow.
    // eslint-disable-next-line no-console
    console.error("[log-latency] write failed", err)
    return new NextResponse(null, { status: 500 })
  }

  return new NextResponse(null, { status: 204 })
}

// ---------------------------------------------------------------------------
// Cache + file resolution
// ---------------------------------------------------------------------------

/**
 * Look up the cached session, or create one for a fresh sessionId. Returns
 * `null` to signal "this session existed before our cache did" (dev-server
 * restart mid-session) so the caller can degrade to append-only mode.
 */
async function getOrInitCachedSession(
  sessionId: string,
  entry: LatencyEntry,
): Promise<CachedSession | null> {
  const existing = SESSION_CACHE.get(sessionId)
  if (existing) return existing

  const shortId = sessionId.slice(0, 8)
  const onDisk = await findExistingSessionFile(shortId)
  if (onDisk) {
    // File exists but we don't have the entries — cannot rebuild summary.
    return null
  }

  const startedMs = entry.ts ?? Date.now()
  const stamp = formatStampForFilename(startedMs)
  const filePath = path.join(LOG_DIR, `${FILE_PREFIX}${stamp}-${shortId}${FILE_SUFFIX}`)
  const cached: CachedSession = { filePath, startedMs, entries: [] }
  SESSION_CACHE.set(sessionId, cached)
  // Pruning runs once per new session — keeps disk usage bounded across many
  // sessions without doing the readdir+stat dance on every single turn.
  await pruneOldSessions()
  return cached
}

async function resolveSessionFilePath(entry: LatencyEntry): Promise<string> {
  const sessionId = entry.sessionId ?? "unknown"
  const shortId = sessionId.slice(0, 8)
  const existing = await findExistingSessionFile(shortId)
  if (existing) return path.join(LOG_DIR, existing)
  const stamp = formatStampForFilename(entry.ts ?? Date.now())
  return path.join(LOG_DIR, `${FILE_PREFIX}${stamp}-${shortId}${FILE_SUFFIX}`)
}

async function findExistingSessionFile(shortId: string): Promise<string | null> {
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

async function pruneOldSessions(): Promise<void> {
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

/**
 * Extract per-segment durations for one entry. Returns `null` for any
 * segment whose timestamps weren't both present so the summary's average
 * doesn't include zero-padding for missing data.
 */
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

  // Highlight the slowest segment on average — the obvious place to look
  // first when the headline number is high. Excludes "total" which would
  // always win.
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
  // Order mirrors the wall-clock pipeline so a reader can scan top-to-bottom
  // and see where time is going. Drop nulls so partial turns still produce a
  // useful — if shorter — block.
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
