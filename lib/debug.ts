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
  pathway: "regex-shortcircuit" | "orchestrate" | "fallback" | "fast-path"
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

export type OmnamStateGetter = () => {
  profile: unknown
  app: unknown
  journey: unknown
}

type OmnamDebug = {
  state: () => ReturnType<OmnamStateGetter>
  turns: () => TurnEntry[]
  effects: () => EffectEntry[]
  snapshot: () => string
}

// Ring buffers live at module scope so the logging helpers and the
// __omnamDebug surface share a single source of truth across hot reloads.
const TURN_BUFFER: TurnEntry[] = []
const EFFECT_BUFFER: EffectEntry[] = []
const MAX_TURNS = 20
const MAX_EFFECTS = 50

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

/** Wire `window.__omnamDebug`. Idempotent; safe to call on every render. */
export function initDebug(getState: OmnamStateGetter): void {
  if (typeof window === "undefined") return
  if (process.env.NODE_ENV === "production") return
  const api: OmnamDebug = {
    state: getState,
    turns: () => TURN_BUFFER.slice(),
    effects: () => EFFECT_BUFFER.slice(),
    snapshot: () =>
      JSON.stringify(
        {
          state: getState(),
          turns: TURN_BUFFER,
          effects: EFFECT_BUFFER,
        },
        (_k, v) => (v instanceof Date ? v.toISOString() : v),
        2,
      ),
  }
  window.__omnamDebug = api
}
