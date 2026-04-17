import type { UserIntent } from "./intents"
import type { RoomPlanAction } from "./classifyRoomPlanLLM"
import type { JourneyState } from "./types"

// ---------------------------------------------------------------------------
// OrchestrateResult — discriminated union of the 3 tool types
// ---------------------------------------------------------------------------

export type OrchestrateResult =
  | { tool: "navigate_and_speak"; intent: UserIntent; speech: string }
  | { tool: "adjust_room_plan"; action: RoomPlanAction; speech: string }
  | { tool: "no_action_speak"; speech: string }

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
  partySize?: number
  budgetRange?: string
  guestComposition?: { adults: number; children: number } | null
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
  const { message, state, ...rest } = input

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
        partySize: rest.partySize,
        budgetRange: rest.budgetRange,
        guestComposition: rest.guestComposition,
      }),
    })

    if (!res.ok) return null

    const data = (await res.json()) as {
      tool: string
      intent?: string
      amenityName?: string
      action?: string
      params?: Record<string, unknown>
      speech?: string
    }

    if (!data.tool || !data.speech) return null

    if (data.tool === "navigate_and_speak") {
      if (!data.intent) return null
      const intent: UserIntent =
        data.intent === "AMENITY_BY_NAME" && data.amenityName
          ? { type: "AMENITY_BY_NAME", amenityName: data.amenityName }
          : ({ type: data.intent } as UserIntent)
      return { tool: "navigate_and_speak", intent, speech: data.speech }
    }

    if (data.tool === "adjust_room_plan") {
      if (!data.action) return null
      const validActions = [
        "adjust_budget",
        "set_room_composition",
        "compact_plan",
        "set_distribution",
        "recompute_with_preferences",
        "no_room_change",
      ]
      if (!validActions.includes(data.action)) return null
      const roomPlanAction = {
        action: data.action,
        params: data.params ?? {},
      } as RoomPlanAction
      return { tool: "adjust_room_plan", action: roomPlanAction, speech: data.speech }
    }

    if (data.tool === "no_action_speak") {
      return { tool: "no_action_speak", speech: data.speech }
    }

    return null
  } catch {
    return null
  }
}
