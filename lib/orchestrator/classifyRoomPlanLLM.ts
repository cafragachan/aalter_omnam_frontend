// ---------------------------------------------------------------------------
// RoomPlanAction — discriminated union of the 6 tool actions
// ---------------------------------------------------------------------------

export type RoomPlanAction =
  | { action: "adjust_budget"; params: { target_per_night?: number } }
  | { action: "set_room_composition"; params: { rooms: { room_id: string; quantity: number }[] } }
  | { action: "compact_plan"; params: { max_rooms?: number } }
  | { action: "set_distribution"; params: { allocation: number[] } }
  | { action: "recompute_with_preferences"; params: { budget_range?: string; distribution_preference?: string; room_type_preference?: string } }
  | { action: "no_room_change"; params: Record<string, never> }

// ---------------------------------------------------------------------------
// RoomPlanContext — the context shape sent to the API route
// ---------------------------------------------------------------------------

export interface RoomPlanContext {
  rooms: { id: string; name: string; occupancy: number; price: number }[]
  partySize?: number
  currentPlan?: {
    entries: { roomName: string; quantity: number; pricePerNight: number }[]
    totalPricePerNight: number
  } | null
  journeyStage: string
  budgetRange?: string
  guestComposition?: { adults: number; children: number } | null
  travelPurpose?: string
}

// ---------------------------------------------------------------------------
// classifyRoomPlanLLM — thin client wrapper
// ---------------------------------------------------------------------------

/**
 * Calls the LLM-based room plan classifier API route.
 * Returns a RoomPlanAction on success, or null if the LLM is unavailable / errors,
 * so the caller can fall back to the existing heuristic logic.
 */
export async function classifyRoomPlanLLM(
  message: string,
  context: RoomPlanContext,
): Promise<RoomPlanAction | null> {
  try {
    const res = await fetch("/api/classify-room-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        rooms: context.rooms,
        partySize: context.partySize,
        currentPlan: context.currentPlan,
        journeyStage: context.journeyStage,
        budgetRange: context.budgetRange,
        guestComposition: context.guestComposition,
        travelPurpose: context.travelPurpose,
      }),
    })

    if (!res.ok) return null

    const data = (await res.json()) as { action: string; params: Record<string, unknown> }

    const validActions = [
      "adjust_budget",
      "set_room_composition",
      "compact_plan",
      "set_distribution",
      "recompute_with_preferences",
      "no_room_change",
    ]

    if (!validActions.includes(data.action)) return null

    return data as RoomPlanAction
  } catch {
    return null
  }
}
