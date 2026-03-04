import { z } from "zod"

const AnalysisResultSchema = z.object({
  personalityTraits: z.array(z.string()),
  travelDriver: z.string(),
})

const SYSTEM_PROMPT = `You are a guest intelligence analyst for a luxury hotel booking platform.
You will receive a guest's conversation transcript, profile data, and behavioral analytics from their interaction with an AI concierge.

Your task is to infer two things:

1. personalityTraits: An array of 3-5 personality descriptors based on how the guest communicates. Consider their tone, word choice, question style, response patterns, patience level, and engagement depth. Examples: "polite", "decisive", "detail-oriented", "warm", "impatient", "budget-conscious", "adventurous", "family-focused", "direct", "friendly", "inquisitive", "reserved".

2. travelDriver: A single phrase describing the guest's PRIMARY motivation for this trip. Determine this from what they spent the most time exploring, what they asked about, and what they expressed enthusiasm for. Examples: "quality of rooms", "amenities and wellness", "surrounding area and activities", "value for money", "business facilities", "family-friendly features", "romantic ambiance", "location and views", "overall luxury experience".

Respond ONLY with valid JSON matching this schema:
{ "personalityTraits": ["trait1", "trait2", ...], "travelDriver": "primary motivation phrase" }`

export async function POST(request: Request) {
  const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY

  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: "AI analysis not configured", code: "NOT_CONFIGURED" }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    const body = await request.json()
    const { profile, guestIntelligence, conversationMessages } = body as {
      profile: Record<string, unknown>
      guestIntelligence: Record<string, unknown>
      conversationMessages: { message: string; timestamp: number }[]
    }

    if (!conversationMessages || conversationMessages.length === 0) {
      return new Response(
        JSON.stringify({ error: "No conversation messages to analyze" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const userMessage = `Guest Profile:
${JSON.stringify(profile, null, 2)}

Behavioral Analytics:
${JSON.stringify(guestIntelligence, null, 2)}

Conversation Transcript (user utterances only):
${conversationMessages.map((m, i) => `${i + 1}. "${m.message}"`).join("\n")}

Based on the above data, analyze the guest's personality traits and primary travel driver.`

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
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error("OpenAI API error:", errorData)
      return new Response(
        JSON.stringify({ error: "Failed to analyze guest data" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      return new Response(
        JSON.stringify({ error: "No content in AI response" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }

    const parsed = JSON.parse(content)
    const validated = AnalysisResultSchema.safeParse(parsed)

    if (!validated.success) {
      console.error("Schema validation failed:", validated.error)
      return new Response(
        JSON.stringify({ error: "Invalid analysis data structure" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
    }

    return new Response(JSON.stringify(validated.data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Guest analysis error:", error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
