import { NextResponse } from "next/server"
import { z } from "zod"

const RequestSchema = z.object({
  scenario: z.object({
    displayName: z.string(),
    speakingStyle: z.string(),
    experienceLevel: z.enum(["novice", "guided", "experienced"]).optional(),
    guidanceNeed: z.enum(["high", "medium", "low"]).optional(),
    disclosureStyle: z.enum(["needs_prompting", "answers_only_latest", "partial_answers", "front_loads"]).optional(),
    frictionStyle: z.string().optional(),
    behaviorRules: z.array(z.string()).optional(),
    expectedCheckpointPath: z.object({
      shouldRevealEarly: z.array(z.string()).optional(),
      revealOnlyWhenAsked: z.array(z.string()).optional(),
      mayResist: z.array(z.string()).optional(),
    }).optional(),
    tripFacts: z.record(z.string()).optional(),
    stopCondition: z.string().optional(),
  }),
  transcript: z.array(z.object({
    sender: z.enum(["user", "ava"]),
    message: z.string(),
  })),
  maxTurns: z.number().int().min(1).max(20).optional(),
})

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.NEXT_PUBLIC_OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 })

  const body = await req.json().catch(() => null)
  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request", details: parsed.error.flatten() }, { status: 400 })
  }

  const { scenario, transcript } = parsed.data
  const behaviorRules = scenario.behaviorRules?.length
    ? scenario.behaviorRules.map((rule) => `- ${rule}`).join("\n")
    : "- Behave like a real customer, not a test script."
  const checkpointPath = scenario.expectedCheckpointPath
    ? JSON.stringify(scenario.expectedCheckpointPath, null, 2)
    : "{}"
  const system = `You simulate a realistic hotel customer speaking to Ava, a luxury hotel booking concierge.

Stay in character. Do not act as Ava. Reply only as the customer.
Use this speaking style: ${scenario.speakingStyle}
Experience level: ${scenario.experienceLevel ?? "guided"}
Guidance need: ${scenario.guidanceNeed ?? "medium"}
Disclosure style: ${scenario.disclosureStyle ?? "answers_only_latest"}
Friction style: ${scenario.frictionStyle ?? "none"}

Customer facts Ava should discover:
${JSON.stringify(scenario.tripFacts ?? {}, null, 2)}

Scenario behavior rules:
${behaviorRules}

Information disclosure path:
${checkpointPath}

Rules:
- Answer Ava's latest useful question naturally.
- Do not dump every fact at once unless the disclosure style is front_loads or Ava asks a broad question that a real experienced customer would answer fully.
- If the disclosure path says a fact should be revealed only when asked, do not mention it until Ava asks directly or gives a helpful guided choice.
- If guidance need is high and Ava asks something vague, ask what she needs or answer only the most obvious part.
- If friction style is price_sensitive, privacy_cautious, distracted, confused, or impatient, let that show lightly without blocking the test.
- If Ava asks multiple questions, answer in your character's natural way.
- If Ava proposes a suitable room plan or opens booking, respond with a short satisfied closing.
- Keep each reply to 1-3 spoken sentences.
- Never mention that you are a synthetic customer, a scenario, checkpoints, or test data.`

  const transcriptBlock = transcript
    .slice(-12)
    .map((m) => `${m.sender === "ava" ? "Ava" : "Customer"}: ${m.message}`)
    .join("\n")

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEBUG_AGENT_CUSTOMER_MODEL || "gpt-5.4-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Conversation so far:\n${transcriptBlock}\n\nWrite the customer's next reply.` },
      ],
      temperature: 0.75,
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    return NextResponse.json({ error: `customer reply failed (${res.status}): ${text}` }, { status: res.status })
  }

  const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }
  const reply = data.choices?.[0]?.message?.content?.trim()
  return NextResponse.json({ reply: reply || "Could you say that another way?" })
}
