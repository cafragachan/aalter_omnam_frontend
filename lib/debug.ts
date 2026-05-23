// ---------------------------------------------------------------------------
// Omnam debug surface (Phase 0 of /home refactor).
//
// Wires `window.__omnamDebug` in dev, exposing recent [TURN] / [EFFECT]
// entries and a live view of the three contexts. No behavior change —
// purely an inspection aid for manual validation and later phases.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __omnamDebug?: OmnamDebug
  }
}

export type TurnEntry = {
  ts: number
  stage: string
  latestMessage: string
  regexIntent: string | null
  llmIntent: string | null
  action: unknown
  speech: string | null
  latencyMs: number
  pathway: "regex-shortcircuit" | "orchestrate" | "fallback" | "fast-path" | "deterministic" | "experiment-action-dispatch"
}

export type EffectEntry = {
  ts: number
  type: string
  params: Record<string, unknown>
  source: "reducer" | "orchestrate" | "event"
  /**
   * Populated only for SPEAK_INTENT effects. Distinguishes speech resolved
   * from orchestrate (`llm`) vs rendered from the local key→string map
   * (`rendered`).
   */
  speechSource?: "llm" | "rendered"
}

/**
 * Per-segment server-side timestamps (Date.now ms) captured inside
 * `/api/orchestrate`. Returned to the client in the response body and
 * stitched onto the LatencyEntry so the on-disk log can attribute time to
 * pre-LLM, LLM, and post-LLM segments. All fields nullable so the formatter
 * can degrade gracefully if a future server change drops one.
 */
export type ServerTimings = {
  requestReceived: number | null
  llmCallStart: number | null
  llmCallEnd: number | null
  responseSent: number | null
  /** "anthropic" | "openai" — useful header context for the human-readable log. */
  provider?: string
  /** Model id actually called (e.g. "claude-haiku-4-5", "gpt-5.4-nano"). */
  model?: string
}

/**
 * Wall-clock (Date.now ms) timestamps for each pipeline checkpoint observed
 * on the client. Nullable to support chat mode (no STT/TTS events) and
 * partial turns (e.g. orchestrate aborted before response landed).
 */
export type ClientWalltimes = {
  /** HeyGen USER_SPEAK_ENDED — moment the user stopped talking. */
  userSpeakEnded: number | null
  /** HeyGen USER_TRANSCRIPTION — moment the final transcript landed. */
  userTranscription: number | null
  /** Right after `classifyIntent()` finished on the client. */
  intentClassified: number | null
  /** Just before client `fetch("/api/orchestrate")`. */
  orchestrateRequestSent: number | null
  /** Right after `await fetch().json()` resolved on the client. */
  orchestrateResponseReceived: number | null
  /** Just before we called HeyGen `session.repeat(text)`. */
  repeatCalled: number | null
  /** HeyGen AVATAR_SPEAK_STARTED — first audio frame from the avatar. */
  avatarSpeakStarted: number | null
  /** HeyGen AVATAR_SPEAK_ENDED — last audio frame. */
  avatarSpeakEnded: number | null
}

export type LatencyEntry = {
  ts: number
  stage: string
  msg: string
  totalMs: number
  /**
   * USER_SPEAK_ENDED -> AVATAR_SPEAK_STARTED. Null when the turn came from
   * chat mode or when HeyGen did not emit a usable speech-end event.
   */
  totalFromSpeechEndMs: number | null
  /** USER_SPEAK_ENDED -> USER_TRANSCRIPTION. This is HeyGen STT/VAD finalization. */
  sttFinalizationMs: number | null
  debounceMs: number | null
  fetchStartMs: number | null
  fetchEndMs: number | null
  orchestrateMs: number | null
  postOrchestrateToAudioMs: number | null
  // ---- Fields added for the per-session human-readable log file ----
  /** UUID v4 generated client-side at "t0" and threaded through orchestrate. */
  turnId?: string
  /** UUID v4 minted once per LiveAvatarContextProvider mount. Names the log file. */
  sessionId?: string
  /** Which dispatch path produced this turn (orchestrate / fast-path / fallback / chat / ...). */
  pathway?: string
  /** Avatar's spoken response, truncated by the formatter. */
  speech?: string | null
  walltimes?: ClientWalltimes
  serverTimings?: ServerTimings | null
}

export type LatencyStageSummary = {
  stage: string
  count: number
  avgTotalMs: number
  avgTotalFromSpeechEndMs: number | null
  avgSttFinalizationMs: number | null
  avgOrchestrateMs: number | null
  avgPostOrchestrateToAudioMs: number | null
}

export type OmnamStateGetter = () => {
  profile: unknown
  app: unknown
  journey: unknown
}

type OmnamDebug = {
  state: () => ReturnType<OmnamStateGetter>
  turns: () => TurnEntry[]
  effects: () => EffectEntry[]
  latencies: () => LatencyEntry[]
  latencySummary: () => LatencyStageSummary[]
  snapshot: () => string
}

// Ring buffers live at module scope so the logging helpers and the
// __omnamDebug surface share a single source of truth across hot reloads.
const TURN_BUFFER: TurnEntry[] = []
const EFFECT_BUFFER: EffectEntry[] = []
const LATENCY_BUFFER: LatencyEntry[] = []
const MAX_TURNS = 20
const MAX_EFFECTS = 50
const MAX_LATENCIES = 20
let LATENCY_SAMPLE_COUNT = 0

function push<T>(buf: T[], entry: T, cap: number): void {
  buf.push(entry)
  if (buf.length > cap) buf.splice(0, buf.length - cap)
}

/** Record a [TURN] entry in the ring buffer AND emit the console log. */
export function logTurn(entry: Omit<TurnEntry, "ts">): void {
  const full: TurnEntry = { ts: Date.now(), ...entry }
  push(TURN_BUFFER, full, MAX_TURNS)
  // eslint-disable-next-line no-console
  console.log("[TURN]", full)
}

/** Record an [EFFECT] entry in the ring buffer AND emit the console log. */
export function logEffect(entry: Omit<EffectEntry, "ts">): void {
  const full: EffectEntry = { ts: Date.now(), ...entry }
  push(EFFECT_BUFFER, full, MAX_EFFECTS)
  // eslint-disable-next-line no-console
  console.log("[EFFECT]", full)
}

function avg(values: Array<number | null>): number | null {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  if (clean.length === 0) return null
  return Math.round(clean.reduce((sum, v) => sum + v, 0) / clean.length)
}

function summarizeLatencies(entries: LatencyEntry[]): LatencyStageSummary[] {
  const byStage = new Map<string, LatencyEntry[]>()
  for (const entry of entries) {
    const bucket = byStage.get(entry.stage) ?? []
    bucket.push(entry)
    byStage.set(entry.stage, bucket)
  }

  return Array.from(byStage.entries()).map(([stage, rows]) => ({
    stage,
    count: rows.length,
    avgTotalMs: avg(rows.map((r) => r.totalMs)) ?? 0,
    avgTotalFromSpeechEndMs: avg(rows.map((r) => r.totalFromSpeechEndMs)),
    avgSttFinalizationMs: avg(rows.map((r) => r.sttFinalizationMs)),
    avgOrchestrateMs: avg(rows.map((r) => r.orchestrateMs)),
    avgPostOrchestrateToAudioMs: avg(rows.map((r) => r.postOrchestrateToAudioMs)),
  }))
}

/**
 * Fire-and-forget POST to `/api/log-latency` so the per-session log file is
 * persisted somewhere readable. In dev the server writes to `logs/*.log`;
 * in prod it writes to a public Vercel Blob whose URL is logged to runtime
 * logs and listed by `GET /api/log-latency`.
 *
 * `keepalive` lets the request survive a tab close so the final turn of a
 * session still gets persisted.
 */
export function flushLatencyToFile(entry: LatencyEntry): void {
  if (typeof window === "undefined") return
  try {
    void fetch("/api/log-latency", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // Logging must never break the user-facing flow.
  }
}

/** Record one user-speech -> avatar-audio latency sample. Emits a rolling 20-sample summary. */
export function logLatency(entry: Omit<LatencyEntry, "ts">): void {
  const full: LatencyEntry = { ts: Date.now(), ...entry }
  push(LATENCY_BUFFER, full, MAX_LATENCIES)
  LATENCY_SAMPLE_COUNT += 1

  // eslint-disable-next-line no-console
  console.log("[TURN-LATENCY]", JSON.stringify(full))

  // Persist to the per-session `logs/*.log` file. No-ops in prod / SSR.
  flushLatencyToFile(full)

  if (LATENCY_BUFFER.length === MAX_LATENCIES && LATENCY_SAMPLE_COUNT % MAX_LATENCIES === 0) {
    // eslint-disable-next-line no-console
    console.log(
      "[TURN-LATENCY-SUMMARY]",
      JSON.stringify({
        sampleCount: LATENCY_SAMPLE_COUNT,
        windowSize: LATENCY_BUFFER.length,
        byStage: summarizeLatencies(LATENCY_BUFFER),
      }),
    )
  }
}

/** Wire `window.__omnamDebug`. Idempotent; safe to call on every render. */
export function initDebug(getState: OmnamStateGetter): void {
  if (typeof window === "undefined") return
  if (process.env.NODE_ENV === "production") return
  const api: OmnamDebug = {
    state: getState,
    turns: () => TURN_BUFFER.slice(),
    effects: () => EFFECT_BUFFER.slice(),
    latencies: () => LATENCY_BUFFER.slice(),
    latencySummary: () => summarizeLatencies(LATENCY_BUFFER),
    snapshot: () =>
      JSON.stringify(
        {
          state: getState(),
          turns: TURN_BUFFER,
          effects: EFFECT_BUFFER,
          latencies: LATENCY_BUFFER,
          latencySummary: summarizeLatencies(LATENCY_BUFFER),
        },
        (_k, v) => (v instanceof Date ? v.toISOString() : v),
        2,
      ),
  }
  window.__omnamDebug = api
}
