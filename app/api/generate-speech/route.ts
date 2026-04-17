import { z } from "zod"

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const SpeechResultSchema = z.object({
  text: z.string().min(1).max(500),
})

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the voice of Ava, an AI concierge for a luxury hotel metaverse experience.

You will receive a "fallback" sentence that describes what you need to communicate, along with guest context. Your job is to rephrase the fallback into something personal and contextual while preserving the same navigational intent.

## Rules

1. Rephrase the fallback text into something personal and contextual — but preserve the same navigational intent.
2. Preserve all room names, monetary amounts, and quantities from the fallback VERBATIM. For example, if the fallback says "$398" or "Standard Mountain View", those exact strings must appear in your output.
3. Keep to 1-3 sentences max. This is spoken aloud by an avatar, not typed.
4. Use the guest's name sparingly — not every response. Vary whether you include it.
5. Reference the guest's last message or preferences when it feels natural, but don't force it.
6. Do NOT invent hotel facts, room names, prices, or amenities not given in the context.
7. Warm luxury concierge tone — not robotic, not overly enthusiastic. Think: a thoughtful host who remembers your preferences.`

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY

  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: "Speech generation not configured", code: "NOT_CONFIGURED" }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    const body = await request.json()
    const {
      fallbackText,
      journeyStage,
      eventType,
      guestFirstName,
      travelPurpose,
      guestComposition,
      interests,
      lastUserMessage,
      recentMessages,
    } = body as {
      fallbackText: string
      journeyStage: string
      eventType?: string
      guestFirstName?: string
      travelPurpose?: string
      guestComposition?: { adults: number; children: number }
      interests?: string[]
      lastUserMessage?: string
      recentMessages?: { role: "user" | "avatar"; text: string }[]
    }

    if (!fallbackText || typeof fallbackText !== "string") {
      return new Response(
        JSON.stringify({ error: "fallbackText string is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // Build context block for the user message
    let contextBlock = `\n\nContext:`
    contextBlock += `\n- Journey stage: ${journeyStage}`
    if (eventType) contextBlock += `\n- Triggered by: ${eventType}`
    if (guestFirstName) contextBlock += `\n- Guest name: ${guestFirstName}`
    if (travelPurpose) contextBlock += `\n- Travel purpose: ${travelPurpose}`
    if (guestComposition) {
      contextBlock += `\n- Party: ${guestComposition.adults} adult${guestComposition.adults !== 1 ? "s" : ""}${guestComposition.children ? `, ${guestComposition.children} child${guestComposition.children !== 1 ? "ren" : ""}` : ""}`
    }
    if (interests?.length) contextBlock += `\n- Interests: ${interests.join(", ")}`
    if (lastUserMessage) contextBlock += `\n- Guest just said: "${lastUserMessage}"`
    if (recentMessages?.length) {
      const recentBlock = recentMessages
        .slice(-4)
        .map((m) => `  ${m.role === "user" ? "Guest" : "Ava"}: "${m.text}"`)
        .join("\n")
      contextBlock += `\n- Recent conversation:\n${recentBlock}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Fallback text to rephrase: "${fallbackText}"${contextBlock}` },
          ],
          temperature: 0.7,
          tools: [
            {
              type: "function",
              function: {
                name: "generate_speech",
                description: "Generate a contextual rephrasing of the fallback text for the avatar to speak",
                parameters: {
                  type: "object",
                  properties: {
                    text: {
                      type: "string",
                      description: "The rephrased speech text (1-3 sentences, preserving all room names, amounts, and quantities verbatim)",
                    },
                  },
                  required: ["text"],
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "generate_speech" } },
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error("OpenAI API error:", errorData)
        return new Response(
          JSON.stringify({ error: "Failed to generate speech" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const data = await response.json()
      const toolCall = data.choices?.[0]?.message?.tool_calls?.[0]
      const args = toolCall?.function?.arguments

      if (!args) {
        return new Response(
          JSON.stringify({ error: "No tool call in AI response" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const parsed = JSON.parse(args)
      const validated = SpeechResultSchema.safeParse(parsed)

      if (!validated.success) {
        console.error("Schema validation failed:", validated.error)
        return new Response(
          JSON.stringify({ error: "Invalid speech structure" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response(JSON.stringify(validated.data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === "AbortError") {
        return new Response(
          JSON.stringify({ error: "Speech generation timed out" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }
      throw err
    }
  } catch (error) {
    console.error("Speech generation error:", error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )
  }
}
