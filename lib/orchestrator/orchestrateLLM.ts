import { z } from "zod"
import type { UserIntent } from "./intents"
import type { JourneyState, TurnDecision } from "./types"
import type { UserDBProfile } from "@/lib/auth-context"
import type {
  PersistedPersonality,
  PersistedPreferences,
  PersistedLoyalty,
} from "@/lib/firebase/types"

// ---------------------------------------------------------------------------
// Zod schema for the Phase 1 TurnDecision envelope. Validation is advisory:
// failures are logged and the field is dropped. Legacy dispatch continues.
// ---------------------------------------------------------------------------

const ProposalSchema = z.object({
  kind: z.enum(["rooms", "amenity", "location", "interior", "exterior", "hotel", "other"]),
  targetId: z.string().optional(),
  label: z.string().optional(),
})

const TurnDecisionActionSchema = z.union([
  z.object({
    type: z.literal("USER_INTENT"),
    intent: z.string(),
    amenityName: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("PROFILE_TURN_RESULT"),
    decision: z.enum(["ask_next", "clarify", "ready"]),
    awaiting: z.string().optional(),
    profileUpdates: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("NO_ACTION") }),
  z.null(),
])

export const TurnDecisionSchema = z.object({
  action: TurnDecisionActionSchema,
  speech: z.string(),
  reasoning: z.string().optional(),
  proposal: ProposalSchema.optional(),
})

// ---------------------------------------------------------------------------
// OrchestrateResult — discriminated union of the 4 tool types
// ---------------------------------------------------------------------------

export type ProfileUpdates = {
  startDate?: string
  endDate?: string
  partySize?: number
  guestComposition?: { adults: number; children: number; childrenAges?: number[] }
  travelPurpose?: string
  roomAllocation?: number[]
}

export type ProfileTurnDecision = "ask_next" | "clarify" | "ready"

export type OrchestrateResult = (
  | { tool: "navigate_and_speak"; intent: UserIntent; speech: string }
  | { tool: "no_action_speak"; speech: string }
  | {
      tool: "profile_turn"
      reasoning?: string
      profileUpdates: ProfileUpdates
      decision: ProfileTurnDecision
      speech: string
    }
) & { decision_envelope?: TurnDecision }

// ---------------------------------------------------------------------------
// OrchestrateInput — the context shape sent to the API route
// ---------------------------------------------------------------------------

export interface OrchestrateInput {
  message: string
  state: JourneyState
  guestFirstName?: string
  travelPurpose?: string
  interests?: string[]
  rooms?: { id: string; name: string; occupancy: number; price: number }[]
  selectedRoom?: {
    id: string
    name: string
    occupancy: number
    price: number
    area?: { min_sqm: number; max_sqm: number; label: string }
    roomType?: string
    features?: string[]
    view?: string[]
    bedding?: string[]
    bath?: string[]
    tech?: string[]
    services?: string[]
  }
  /**
   * The actual amenity names available at the currently-selected hotel
   * (e.g., ["Pool", "Lobby", "Conference Room"]). Sent to the orchestrate
   * prompt so the LLM grounds its speech in real property data and doesn't
   * hallucinate amenities from the intent-classification enum (the enum
   * lists pool/spa/restaurant/gym/etc as CATEGORIES, but any given property
   * has a smaller subset). Drives the "only mention these amenities" guard
   * in the HOTEL_EXPLORATION / AMENITY_VIEWING / ROOM_SELECTED prompt block.
   */
  hotelAmenityNames?: string[]
  partySize?: number
  budgetRange?: string
  guestComposition?: { adults: number; children: number } | null
  profileAwaiting?: string
  startDate?: string
  endDate?: string
  roomAllocation?: number[]
  identity?: UserDBProfile | null
  personality?: PersistedPersonality | null
  preferences?: PersistedPreferences | null
  loyalty?: PersistedLoyalty | null
  conversationHistory?: { role: "user" | "avatar"; text: string }[]
  /**
   * Phase 3: the regex classifier's best guess for this turn, forwarded as
   * a hint to the LLM. The server prompt instructs the model to treat this
   * as a tiebreaker: prefer it when non-UNKNOWN and unambiguous, override
   * only when the conversation clearly disagrees. Unused during
   * PROFILE_COLLECTION (that stage uses the `profile_turn` tool, not
   * navigation intents).
   */
  regexHint?: string
  /**
   * Optional abort signal so callers can terminate the in-flight fetch
   * when a newer orchestrate call supersedes this one (e.g. fast-path
   * fired, new user turn started, stage transitioned, component unmounted).
   * When the signal aborts, this function returns null without logging.
   */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// orchestrateLLM — thin client wrapper
// ---------------------------------------------------------------------------

/**
 * Calls the consolidated /api/orchestrate endpoint.
 * Returns an OrchestrateResult on success, or null if the LLM is unavailable / errors,
 * so the caller can fall back to regex intent + hardcoded speech.
 */
export async function orchestrateLLM(
  input: OrchestrateInput,
): Promise<OrchestrateResult | null> {
  const { message, state, signal, ...rest } = input

  const journeyContext: Record<string, string | undefined> = {
    stage: state.stage,
  }

  if ("subState" in state && state.subState) {
    journeyContext.subState = state.subState
  }
  if ("lastProposal" in state && state.lastProposal) {
    journeyContext.lastProposal = state.lastProposal
  }
  if ("suggestedAmenityName" in state && state.suggestedAmenityName) {
    journeyContext.suggestedAmenityName = state.suggestedAmenityName
  }
  if ("suggestedNext" in state && state.suggestedNext) {
    journeyContext.suggestedNext = state.suggestedNext
  }

  try {
    const res = await fetch("/api/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        journeyContext,
        guestFirstName: rest.guestFirstName,
        travelPurpose: rest.travelPurpose,
        interests: rest.interests,
        rooms: rest.rooms,
        selectedRoom: rest.selectedRoom,
        hotelAmenityNames: rest.hotelAmenityNames,
        partySize: rest.partySize,
        budgetRange: rest.budgetRange,
        guestComposition: rest.guestComposition,
        profileAwaiting: rest.profileAwaiting,
        startDate: rest.startDate,
        endDate: rest.endDate,
        roomAllocation: rest.roomAllocation,
        identity: rest.identity,
        personality: rest.personality,
        preferences: rest.preferences,
        loyalty: rest.loyalty,
        conversationHistory: rest.conversationHistory,
        regexHint: rest.regexHint,
      }),
      signal,
    })

    if (!res.ok) return null

    const data = (await res.json()) as {
      tool: string
      intent?: string
      amenityName?: string
      speech?: string
      reasoning?: string
      profileUpdates?: ProfileUpdates
      decision?: ProfileTurnDecision
      // Phase 1 envelope. Optional on the wire — server always emits it,
      // but we treat missing/invalid as soft-warn, not fatal.
      decision_envelope?: unknown
    }

    if (!data.tool || !data.speech) return null

    // Phase 1: validate the envelope. Failures are advisory. The legacy tool
    // field still drives dispatch; the envelope is shadow-groundwork only.
    // Server emits under `decision_envelope` to avoid collision with the
    // profile_turn legacy `decision` enum string.
    const rawEnvelope = data.decision_envelope
    let envelope: TurnDecision | undefined
    if (rawEnvelope !== undefined && rawEnvelope !== null) {
      const parsed = TurnDecisionSchema.safeParse(rawEnvelope)
      if (parsed.success) {
        envelope = parsed.data as TurnDecision
      } else {
        console.warn("[DECISION-ENVELOPE] invalid", {
          tool: data.tool,
          error: parsed.error.flatten(),
        })
      }
    } else {
      console.warn("[DECISION-ENVELOPE] missing or invalid", {
        tool: data.tool,
      })
    }

    if (data.tool === "profile_turn") {
      if (!data.decision) return null
      const base = {
        tool: "profile_turn" as const,
        reasoning: data.reasoning,
        profileUpdates: data.profileUpdates ?? {},
        decision: data.decision,
        speech: data.speech,
      }
      return envelope ? { ...base, decision_envelope: envelope } : base
    }

    if (data.tool === "navigate_and_speak") {
      if (!data.intent) return null
      const intent: UserIntent =
        data.intent === "AMENITY_BY_NAME" && data.amenityName
          ? { type: "AMENITY_BY_NAME", amenityName: data.amenityName }
          : ({ type: data.intent } as UserIntent)
      const base = { tool: "navigate_and_speak" as const, intent, speech: data.speech }
      return envelope ? { ...base, decision_envelope: envelope } : base
    }

    if (data.tool === "no_action_speak") {
      const base = { tool: "no_action_speak" as const, speech: data.speech }
      return envelope ? { ...base, decision_envelope: envelope } : base
    }

    return null
  } catch (err) {
    // AbortController-triggered termination: the caller explicitly cancelled
    // this request because a newer orchestrate superseded it (fast-path,
    // new turn, stage change, unmount). Return null silently so the caller's
    // response handler can short-circuit without hitting the degraded-mode
    // fallback path (which would speak over the superseding turn).
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      return null
    }
    return null
  }
}
