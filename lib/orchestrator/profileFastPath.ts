// ---------------------------------------------------------------------------
// PROFILE_COLLECTION fast-path (Phase 2.5 of /home refactor)
//
// Pure module. Given the `profileCollectionAwaiting` value before and after
// this turn's regex extraction, decide whether to speak a canned next-question
// immediately instead of waiting for the LLM (3-5s, 700ms debounce + gpt-4o).
//
// The LLM still runs in the background to validate the regex extraction and
// apply any refinements the regex missed; its speech is ignored when fast-path
// fires (see useJourney.ts). See plan Phase 2.5 for full rationale.
// ---------------------------------------------------------------------------
//
// Keep `CLIENT_CANNED_SPEECH` in sync with the server-side `CANNED_SPEECH`
// map in `app/api/orchestrate/route.ts`. Values must be byte-for-byte
// identical so the fast-path response and a fallback orchestrate response
// never collide on the same user turn.
// ---------------------------------------------------------------------------

import type { JourneyState } from "./types"

/** Same enum the journey-machine's `PROFILE_COLLECTION` state tracks. */
export type ProfileAwaiting = Extract<JourneyState, { stage: "PROFILE_COLLECTION" }>["awaiting"]

/** Subset of ProfileAwaiting that has a canned question we can speak instantly. */
export type FastPathField =
  | "dates"
  | "guests"
  | "guest_breakdown"
  | "children_ages"
  | "travel_purpose"
  | "room_distribution"

/** Mirror of the server-side CANNED_SPEECH map. Keep verbatim. */
export const CLIENT_CANNED_SPEECH: Record<FastPathField, string> = {
  dates: "When are you thinking of traveling?",
  guests: "How many will be joining you?",
  guest_breakdown: "Will it be all adults, or are there any little ones in your group?",
  children_ages: "And how old are the little ones?",
  travel_purpose: "What brings you to the area?",
  room_distribution: "How would you like to split the guests across rooms?",
}

const FAST_PATH_FIELDS: ReadonlySet<FastPathField> = new Set<FastPathField>([
  "dates",
  "guests",
  "guest_breakdown",
  "children_ages",
  "travel_purpose",
  "room_distribution",
])

function isFastPathField(a: ProfileAwaiting): a is FastPathField {
  return FAST_PATH_FIELDS.has(a as FastPathField)
}

export type FastPathArgs = {
  /** What was missing BEFORE this turn's regex extraction merged in. */
  prevAwaiting: ProfileAwaiting
  /** What's missing AFTER this turn's regex extraction. */
  freshAwaiting: ProfileAwaiting
  /** Latest user utterance — only used for diagnostics / logs. */
  latestMessage: string
  /** How many user turns so far, including this one. Must be >= 1 to fire. */
  turnCount: number
}

export type FastPathResult =
  | {
      eligible: true
      nextAwaiting: FastPathField
      cannedSpeech: string
      reason: string
    }
  | { eligible: false; reason: string }

/**
 * Pure decision function. No React, no refs, no I/O.
 *
 * Eligibility:
 *   1. turnCount >= 1 (never fires on cold-start / avatar welcome)
 *   2. freshAwaiting is one of the 6 FAST_PATH_FIELDS (not "ready",
 *      "extracting", "interests", or "dates_and_guests")
 *   3. freshAwaiting differs from prevAwaiting — progress was made this turn.
 *      Exception: if prevAwaiting is the INITIAL_JOURNEY_STATE awaiting
 *      ("dates_and_guests") AND freshAwaiting is a single-field fast-path
 *      field, that still counts as progress (the user filled one of the two
 *      missing fields on their first real answer).
 */
export function evaluateFastPath(args: FastPathArgs): FastPathResult {
  const { prevAwaiting, freshAwaiting, turnCount } = args

  if (turnCount < 1) {
    return { eligible: false, reason: "cold-start: turnCount < 1" }
  }

  if (!isFastPathField(freshAwaiting)) {
    return {
      eligible: false,
      reason: `freshAwaiting="${freshAwaiting}" not in fast-path set`,
    }
  }

  // "dates_and_guests" is the initial state when both are missing. If the
  // user provided ONE of those (now we only need the other), that's real
  // progress — fire fast-path. Any other same-value prev/fresh means the
  // regex didn't advance the state this turn; fall through to LLM.
  if (prevAwaiting === freshAwaiting) {
    return {
      eligible: false,
      reason: `no progress: prevAwaiting == freshAwaiting (${freshAwaiting})`,
    }
  }

  // Any transition INTO children_ages means guestComposition was extracted
  // this turn (regardless of whether prev was "guest_breakdown" or
  // "dates_and_guests" — the user may have dumped dates+composition in one
  // compound utterance). The regex extractor in useUserProfile.ts parses
  // "4 adults, 4 children" unreliably (frequently gets children right but
  // defaults adults to 1, corrupting partySize). Defer to the LLM for any
  // incoming transition to children_ages. Phase 4 (server-side transcript
  // reconstruction) removes the fragile regex entirely.
  if (freshAwaiting === "children_ages" && prevAwaiting !== "children_ages") {
    return {
      eligible: false,
      reason: `${prevAwaiting}→children_ages uses LLM extraction`,
    }
  }

  return {
    eligible: true,
    nextAwaiting: freshAwaiting,
    cannedSpeech: CLIENT_CANNED_SPEECH[freshAwaiting],
    reason: `progressed ${prevAwaiting} -> ${freshAwaiting}`,
  }
}
