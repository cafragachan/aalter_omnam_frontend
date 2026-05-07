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

const HOTEL_EXPLORATION_ALLOWED = new Set<UserIntent["type"]>([
  "ROOMS",
  "AMENITIES",
  "AMENITY_BY_NAME",
  "LOCATION",
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
  "LOCATION",
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

  // Generic "what amenities do you have?" is intentionally not handled here:
  // the LLM path has richer grounding for described-only amenities. Clear
  // command forms like "show amenities" are deterministic.
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
