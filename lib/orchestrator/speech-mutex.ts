// ---------------------------------------------------------------------------
// Speech Mutex — per-utterance lock shared by every avatar-speech producer.
//
// Why this exists:
//   On a single user utterance, multiple async pathways can independently
//   reach `repeat()` on the HeyGen avatar:
//     • the deterministic exploration path → reducer SPEAK_INTENT
//     • the LLM envelope dispatch → reducer SPEAK_INTENT
//     • the LLM `no_action_speak` / `profile_turn` direct speech
//     • the Room Planner result speech
//   With no coordination, two or three of them collide: the avatar gets
//   `interrupt(); repeat(A); interrupt(); repeat(B);` within ~1s and the
//   user hears a truncated A followed by B (the "fighting systems" bug).
//
// Contract:
//   • `beginUtteranceTurn()` is called ONCE per user utterance, at the top
//     of the user-messages effect in useJourney. It mints a monotonic id.
//   • Every speech producer that fires *in response to* that utterance must
//     call `claimSpeech(turnId, source)` before invoking `repeat()`.
//   • First claimant wins; subsequent claimants get `false` and must
//     suppress their speech (side-effects may still run — only `repeat()` is
//     gated).
//   • Same source re-claiming the same turn is allowed (lets a single
//     reducer effect emit a loading + result pair without self-blocking).
//   • Speech NOT tied to an utterance (UI button taps, page-load opening
//     line, panel-open re-plans) bypasses the lock entirely — those callers
//     just don't call `claimSpeech` and speak unconditionally.
// ---------------------------------------------------------------------------

export type SpeechSource =
  | "deterministic"          // exploration deterministic path → reducer SPEAK_INTENT
  | "deterministic_profile"  // profile fast-path direct speech
  | "reducer"                // generic reducer SPEAK_INTENT (utterance-driven)
  | "llm_envelope"           // LLM decision_envelope → reducer SPEAK_INTENT
  | "llm_no_action"          // LLM no_action_speak direct speech
  | "llm_profile"            // LLM profile_turn direct speech
  | "llm_fallback"           // LLM degraded-mode fallback
  | "room_planner"           // /api/room-planner result speech

let _currentTurnId = 0
let _claimedBy: SpeechSource | null = null

/**
 * Begin a new utterance turn. Resets any prior claim and returns the new id.
 * Call this exactly once per user message, before any speech producer runs.
 */
export function beginUtteranceTurn(): number {
  _currentTurnId += 1
  _claimedBy = null
  return _currentTurnId
}

/** Read the current turn id. Async producers capture this at fire-time and
 *  pass it to `claimSpeech` so a superseded turn can no longer speak. */
export function getCurrentTurnId(): number {
  return _currentTurnId
}

/**
 * Attempt to claim the speech lock for `turnId`.
 *  - Returns true: caller should proceed with `interrupt(); repeat(text)`.
 *  - Returns false: another source already spoke this turn, OR `turnId`
 *    is stale (a newer turn superseded this one). Caller must suppress.
 *
 * Same `source` re-claiming the same turn is treated as success — useful
 * for the FETCH_POIS loading-then-result pattern where one logical effect
 * produces two speeches.
 */
export function claimSpeech(turnId: number, source: SpeechSource): boolean {
  if (turnId !== _currentTurnId) return false
  if (_claimedBy !== null && _claimedBy !== source) return false
  _claimedBy = source
  return true
}

/** Inspect the current claim — for debug logging only. */
export function getClaimedSource(): SpeechSource | null {
  return _claimedBy
}
