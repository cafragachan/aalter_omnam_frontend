export interface SpeechContext {
  journeyStage: string
  eventType?: string
  guestFirstName?: string
  travelPurpose?: string
  guestComposition?: { adults: number; children: number }
  interests?: string[]
  lastUserMessage?: string
  recentMessages?: { role: "user" | "avatar"; text: string }[]
}

/**
 * Calls the LLM-based speech generation API route.
 * Returns the generated text on success, or null if the LLM is unavailable / errors,
 * so the caller can fall back to the hardcoded fallback text.
 */
export async function generateSpeechLLM(
  fallbackText: string,
  context: SpeechContext,
): Promise<string | null> {
  try {
    const res = await fetch("/api/generate-speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fallbackText,
        journeyStage: context.journeyStage,
        eventType: context.eventType,
        guestFirstName: context.guestFirstName,
        travelPurpose: context.travelPurpose,
        guestComposition: context.guestComposition,
        interests: context.interests,
        lastUserMessage: context.lastUserMessage,
        recentMessages: context.recentMessages,
      }),
    })

    if (!res.ok) return null

    const data = (await res.json()) as { text: string }

    if (!data.text) return null

    return data.text
  } catch {
    return null
  }
}
