import { z } from "zod"

const GuestCompositionSchema = z.object({
  adults: z.number(),
  children: z.number(),
  childrenAges: z.array(z.number()).nullable().optional(),
}).nullable().optional()

const ExtractedProfileSchema = z.object({
  name: z.string().nullable().optional(),
  partySize: z.number().nullable().optional(),
  destination: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  interests: z.array(z.string()).nullable().optional().transform((v) => v ?? []),
  travelPurpose: z.string().nullable().optional(),
  budgetRange: z.string().nullable().optional(),
  roomTypePreference: z.string().nullable().optional(),
  dietaryRestrictions: z.array(z.string()).nullable().optional().transform((v) => v ?? []),
  accessibilityNeeds: z.array(z.string()).nullable().optional().transform((v) => v ?? []),
  amenityPriorities: z.array(z.string()).nullable().optional().transform((v) => v ?? []),
  nationality: z.string().nullable().optional(),
  arrivalTime: z.string().nullable().optional(),
  guestComposition: GuestCompositionSchema,
  roomAllocation: z.array(z.number()).nullable().optional(),
})

type ExtractedProfile = z.infer<typeof ExtractedProfileSchema>

const SYSTEM_PROMPT = `You are a profile data extraction assistant for a luxury hotel booking AI agent.
Your job is to extract structured information from user utterances in a conversation.

Extract the following fields when mentioned:
- name: The user's name (first name or full name)
- partySize: Total number of guests/travelers (as a number)
- guestComposition: Breakdown of adults and children. Example: { "adults": 2, "children": 2, "childrenAges": [5, 8] }
- destination: Where they want to travel (city, country, or region)
- startDate: Travel start date in ISO format (YYYY-MM-DD) if mentioned
- endDate: Travel end date in ISO format (YYYY-MM-DD) if mentioned
- interests: Array of interests/activities (e.g., ["relaxation", "spa", "hiking", "fine dining"])
- travelPurpose: Purpose of travel (business, leisure, honeymoon, family vacation, celebration, etc.)
- budgetRange: Budget indication (e.g., "luxury", "mid-range", "$500-1000/night")
- roomTypePreference: Room type or style preference (e.g., "suite", "ocean view", "high floor", "modern", "penthouse")
- dietaryRestrictions: Food allergies or dietary needs (e.g., ["vegetarian", "gluten-free", "nut allergy"])
- accessibilityNeeds: Mobility or accessibility requirements (e.g., ["wheelchair accessible", "ground floor"])
- amenityPriorities: Amenities the guest values (e.g., ["spa", "pool", "gym", "restaurant"]) in order of importance
- nationality: Guest's country of origin or where they're traveling from (e.g., "UK", "Germany", "United States")
- arrivalTime: Expected arrival time if mentioned (e.g., "afternoon", "3pm", "late evening")
- roomAllocation: How guests are distributed across rooms, as an array of numbers. Each number is the guest count for one room. Example: "2 rooms, 4 and 2" → [4, 2]. "All in one room" with 4 guests → [4]. "Separate rooms" with 3 guests → [1, 1, 1]. "3 rooms, 2 each" → [2, 2, 2]. Only set if the user explicitly describes room distribution.

Rules:
- Only extract information that is explicitly stated or clearly implied
- Return null for fields not mentioned
- For dates, use the current year if not specified
- For party size, include the speaker (e.g., "me and my wife" = 2)
- For guestComposition, extract adult/child split and children's ages if mentioned (e.g., "me and my wife and two kids, 5 and 8" → { adults: 2, children: 2, childrenAges: [5, 8] })
- If the user gives a total guest count without specifying adults vs children (e.g., "5 guests"), set partySize but leave guestComposition as null — the system will ask a follow-up
- If the user explicitly says no children (e.g., "no kids", "all adults", "just us", "just me and my wife"), set guestComposition with children: 0 and adults equal to partySize
- "Just me and my wife/husband/partner" → partySize: 2, guestComposition: { adults: 2, children: 0, childrenAges: null }
- For nationality, extract from phrases like "traveling from London", "based in Germany", "coming from Dubai"
- Be conservative — don't infer information that isn't clearly stated

Respond ONLY with valid JSON matching this schema, no other text.`

export async function POST(request: Request) {
  const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY

  if (!openaiKey) {
    // Return 501 Not Implemented to signal that AI extraction is not available
    // This allows the client to gracefully fall back to regex-only extraction
    return new Response(
      JSON.stringify({ error: "AI extraction not configured", code: "NOT_CONFIGURED" }),
      { status: 501, headers: { "Content-Type": "application/json" } }
    )
  }

  try {
    const body = await request.json()
    const { utterances, currentProfile } = body as {
      utterances: string[]
      currentProfile?: Partial<ExtractedProfile>
    }

    if (!utterances || !Array.isArray(utterances) || utterances.length === 0) {
      return new Response(
        JSON.stringify({ error: "utterances array is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const userMessage = `Current profile state:
${JSON.stringify(currentProfile ?? {}, null, 2)}

Recent user utterances to extract from:
${utterances.map((u, i) => `${i + 1}. "${u}"`).join("\n")}

Extract any new profile information from these utterances. Only include fields where you found new information.`

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
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error("OpenAI API error:", errorData)
      return new Response(
        JSON.stringify({ error: "Failed to extract profile data" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      return new Response(
        JSON.stringify({ error: "No content in AI response" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const parsed = JSON.parse(content)
    const validated = ExtractedProfileSchema.safeParse(parsed)

    if (!validated.success) {
      console.error("Schema validation failed:", validated.error)
      return new Response(
        JSON.stringify({ error: "Invalid profile data structure" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    return new Response(JSON.stringify({ profile: validated.data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Profile extraction error:", error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}
