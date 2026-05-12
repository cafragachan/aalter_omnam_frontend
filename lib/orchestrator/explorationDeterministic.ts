import { classifyIntent, type UserIntent } from "./intents"
import type { JourneyState } from "./types"

export type DeterministicExplorationResult =
  | {
      handled: true
      intent: UserIntent
      confidence: number
      reasons: string[]
    }
  | {
      handled: false
      confidence: number
      reasons: string[]
    }

const FACTUAL_QUESTION_RE =
  /(?:^|\b)(what|how|why|when|where|which|who|is there|are there|can i|could i|tell me|describe|explain|do you|does it|does the)\b|[?]\s*$/i
const NAV_ACTION_RE =
  /\b(show|take me|go to|see the|let me see|let'?s see|bring me|head to|navigate|switch to|open|pull up|check out|look at|explore|visit|browse|move to|jump to)\b/i
const GENERIC_AMENITIES_RE =
  /\b(?:show|list|open|pull up|see|browse|explore|check out)\s+(?:the\s+)?(?:amenities|facilities)\b|\b(?:amenities|facilities)\s+(?:please|now)\b/i

// Listing-style factual questions that should ALSO route to AMENITIES
// deterministically (not escalate to the LLM). Catching these here makes the
// path consistent: same input → reducer's canonical listing every time.
// Without this, the LLM picks between AMENITIES intent and no_action_speak
// turn-to-turn, producing two different speech outputs for the same question.
const LIST_AMENITIES_QUESTION_RE =
  /\b(?:what|which|any|are\s+there|do\s+you\s+have|tell\s+me\s+(?:about\s+(?:your|the))?|list)\s+(?:the\s+|your\s+|any\s+)?(?:amenities|facilities|amenity|facility)\b/i

// LOCATION is intentionally NOT deterministic anymore: the LLM owns the
// branch where "show me the area" routes to LOCATE_INTEREST_POINTS using
// the guest's stored interests, or falls back to asking what they'd like
// to see nearby when interests are empty.
const HOTEL_EXPLORATION_ALLOWED = new Set<UserIntent["type"]>([
  "ROOMS",
  "AMENITIES",
  "AMENITY_BY_NAME",
  "BACK",
  "HOTEL_EXPLORE",
  "TRAVEL_TO_HOTEL",
  "BOOK",
  "OTHER_OPTIONS",
  "LIGHTING_CHANGE",
  "LIGHTING_SET",
])

const AMENITY_VIEWING_ALLOWED = new Set<UserIntent["type"]>([
  "ROOMS",
  "AMENITIES",
  "AMENITY_BY_NAME",
  "BACK",
  "HOTEL_EXPLORE",
  "TRAVEL_TO_HOTEL",
  "BOOK",
  "OTHER_OPTIONS",
  "NEGATIVE",
  "LIGHTING_CHANGE",
  "LIGHTING_SET",
])

function isFactualQuestion(text: string): boolean {
  return FACTUAL_QUESTION_RE.test(text) && !NAV_ACTION_RE.test(text)
}

export function evaluateDeterministicExplorationTurn(args: {
  latestMessage: string
  state: JourneyState
}): DeterministicExplorationResult {
  const text = args.latestMessage.trim()
  if (!text) return { handled: false, confidence: 0, reasons: ["empty_message"] }

  const stage = args.state.stage
  if (stage !== "HOTEL_EXPLORATION" && stage !== "AMENITY_VIEWING") {
    return { handled: false, confidence: 0, reasons: [`unsupported_stage_${stage}`] }
  }

  // Listing-style amenity questions ("what amenities do you have?", "list
  // your facilities", "any amenities?") route directly to AMENITIES so the
  // reducer's canonical LIST_AMENITIES speech plays — same input, same
  // speech every time. Must run BEFORE the factual_question_escalate guard
  // because these questions also match FACTUAL_QUESTION_RE.
  if (LIST_AMENITIES_QUESTION_RE.test(text)) {
    return {
      handled: true,
      intent: { type: "AMENITIES" },
      confidence: 0.95,
      reasons: ["list_amenities_question_deterministic"],
    }
  }

  // Factual questions escalate to the LLM so it can use rich amenity / hotel
  // grounding to answer ("tell me about the spa", "where is this hotel?").
  // Clear command forms like "show amenities" are deterministic via the
  // intent classifier below.
  if (isFactualQuestion(text) && !GENERIC_AMENITIES_RE.test(text)) {
    return { handled: false, confidence: 0.35, reasons: ["factual_question_escalate"] }
  }

  const intent = classifyIntent(text)
  if (intent.type === "UNKNOWN") {
    return { handled: false, confidence: 0.25, reasons: ["unknown_intent"] }
  }

  // A bare "yes" inside amenity viewing is contextually ambiguous: it can mean
  // either "tell me more" or "take me to the suggested next amenity". Keep it
  // on the LLM path because the LLM authored the prior prompt.
  if (stage === "AMENITY_VIEWING" && intent.type === "AFFIRMATIVE") {
    return { handled: false, confidence: 0.45, reasons: ["amenity_affirmative_ambiguous"] }
  }

  if (stage === "HOTEL_EXPLORATION" && intent.type === "AFFIRMATIVE") {
    const hasStandingProposal =
      args.state.lastProposal !== undefined || args.state.suggestedAmenityName !== undefined
    return hasStandingProposal
      ? { handled: true, intent, confidence: 0.88, reasons: ["hotel_affirmative_with_proposal"] }
      : { handled: false, confidence: 0.45, reasons: ["hotel_affirmative_without_proposal"] }
  }

  const allowed = stage === "HOTEL_EXPLORATION"
    ? HOTEL_EXPLORATION_ALLOWED
    : AMENITY_VIEWING_ALLOWED

  if (!allowed.has(intent.type)) {
    return { handled: false, confidence: 0.4, reasons: [`intent_not_deterministic_${intent.type}`] }
  }

  const confidence = intent.type === "AMENITY_BY_NAME" ? 0.9 : 0.92
  return { handled: true, intent, confidence, reasons: [`${stage.toLowerCase()}_${intent.type.toLowerCase()}`] }
}
