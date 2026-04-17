import type { UserIntent } from "./intents"
import type { JourneyState } from "./types"

/**
 * Calls the LLM-based intent classifier API route.
 * Returns a UserIntent on success, or null if the LLM is unavailable / errors,
 * so the caller can fall back to the regex result.
 */
export async function classifyIntentLLM(
  message: string,
  state: JourneyState,
): Promise<UserIntent | null> {
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
    const res = await fetch("/api/classify-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, journeyContext }),
    })

    if (!res.ok) return null

    const data = (await res.json()) as { intent: string; amenityName?: string }

    if (data.intent === "AMENITY_BY_NAME" && data.amenityName) {
      return { type: "AMENITY_BY_NAME", amenityName: data.amenityName }
    }

    return { type: data.intent } as UserIntent
  } catch {
    return null
  }
}
