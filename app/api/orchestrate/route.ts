import { z } from "zod"
import { SALES_PERSONA, buildGuestIntelligenceBlock } from "@/lib/avatar-context-builder"
import type { UserDBProfile } from "@/lib/auth-context"
import type {
  PersistedPersonality,
  PersistedPreferences,
  PersistedLoyalty,
} from "@/lib/firebase/types"

// ---------------------------------------------------------------------------
// Intent enum — mirrors UserIntent from lib/orchestrator/intents.ts
// ---------------------------------------------------------------------------

const INTENT_VALUES = [
  "ROOMS",
  "AMENITIES",
  "AMENITY_BY_NAME",
  "LOCATION",
  "INTERIOR",
  "EXTERIOR",
  "BACK",
  "HOTEL_EXPLORE",
  "DOWNLOAD_DATA",
  "BOOK",
  "AFFIRMATIVE",
  "NEGATIVE",
  "TRAVEL_TO_HOTEL",
  "OTHER_OPTIONS",
  "ROOM_TOGETHER",
  "ROOM_SEPARATE",
  "ROOM_AUTO",
  "ROOM_PLAN_CHEAPER",
  "ROOM_PLAN_COMPACT",
  "RETURN_TO_LOUNGE",
  "END_EXPERIENCE",
  "UNKNOWN",
] as const

// ---------------------------------------------------------------------------
// Zod schemas for tool argument validation
// ---------------------------------------------------------------------------

const NavigateAndSpeakSchema = z.object({
  intent: z.enum(INTENT_VALUES),
  amenityName: z.string().optional(),
  speech: z.string().min(1).max(500),
})

const AdjustRoomPlanSchema = z.object({
  action: z.enum([
    "adjust_budget",
    "set_room_composition",
    "compact_plan",
    "set_distribution",
    "recompute_with_preferences",
    "no_room_change",
  ]),
  speech: z.string().min(1).max(500),
  // Flat params — each action uses a subset of these
  target_per_night: z.number().optional(),
  rooms: z.array(z.object({ room_id: z.string(), quantity: z.number() })).optional(),
  max_rooms: z.number().optional(),
  allocation: z.array(z.number()).optional(),
  budget_range: z.string().optional(),
  distribution_preference: z.string().optional(),
  room_type_preference: z.string().optional(),
})

const NoActionSpeakSchema = z.object({
  speech: z.string().min(1).max(500),
})

const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  navigate_and_speak: NavigateAndSpeakSchema,
  adjust_room_plan: AdjustRoomPlanSchema,
  no_action_speak: NoActionSpeakSchema,
}

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

interface RoomInfo {
  id: string
  name: string
  occupancy: number
  price: number
}

interface JourneyContext {
  stage: string
  subState?: string
  lastProposal?: string
  suggestedAmenityName?: string
  suggestedNext?: string
}

interface RequestBody {
  message: string
  journeyContext: JourneyContext
  rooms?: RoomInfo[]
  partySize?: number
  budgetRange?: string
  guestComposition?: { adults: number; children: number }
  travelPurpose?: string
  guestFirstName?: string
  interests?: string[]
  profileAwaiting?: string
  startDate?: string
  endDate?: string
  roomAllocation?: number[]
  identity?: UserDBProfile | null
  personality?: PersistedPersonality | null
  preferences?: PersistedPreferences | null
  loyalty?: PersistedLoyalty | null
  conversationHistory?: { role: "user" | "avatar"; text: string }[]
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(body: RequestBody): string {
  const isProfileCollection = body.journeyContext.stage === "PROFILE_COLLECTION"
  const hasRooms = body.rooms && body.rooms.length > 0

  // --- Room catalog block (only when rooms are provided) ---
  let roomBlock = ""
  if (hasRooms) {
    const roomCatalog = body.rooms!
      .map((r) => `  - ${r.name} (id: "${r.id}", occupancy: ${r.occupancy}, price: $${r.price}/night)`)
      .join("\n")
    roomBlock = `\n\n## Available rooms\n\n${roomCatalog}`
  }

  // --- Guest context block ---
  let contextBlock = ""
  if (body.partySize) contextBlock += `\n- Party size: ${body.partySize} guests`
  if (body.guestComposition) {
    contextBlock += `\n- Guest composition: ${body.guestComposition.adults} adults, ${body.guestComposition.children} children`
  }
  if (body.budgetRange) contextBlock += `\n- Budget range: ${body.budgetRange}`
  if (body.travelPurpose) contextBlock += `\n- Travel purpose: ${body.travelPurpose}`
  if (body.guestFirstName) contextBlock += `\n- Guest name: ${body.guestFirstName}`
  if (body.interests?.length) contextBlock += `\n- Interests: ${body.interests.join(", ")}`
  const guestBlock = contextBlock ? `\n\n## Guest context${contextBlock}` : ""

  // --- Profile collection block ---
  let profileCollectionBlock = ""
  if (isProfileCollection) {
    // Summarise what's actually on file so the LLM reasons about present data,
    // not just the single profileAwaiting label.
    const collectedLines: string[] = []
    if (body.startDate && body.endDate) {
      collectedLines.push(`- Dates: ${body.startDate} to ${body.endDate}`)
    } else if (body.startDate) {
      collectedLines.push(`- Start date: ${body.startDate} (end date missing)`)
    } else if (body.endDate) {
      collectedLines.push(`- End date: ${body.endDate} (start date missing)`)
    }
    if (body.partySize) {
      collectedLines.push(`- Party size: ${body.partySize} guest${body.partySize === 1 ? "" : "s"}`)
    }
    if (body.guestComposition) {
      collectedLines.push(`- Guest composition: ${body.guestComposition.adults} adults, ${body.guestComposition.children} children`)
    }
    if (body.travelPurpose) {
      collectedLines.push(`- Travel purpose: ${body.travelPurpose}`)
    }
    if (body.roomAllocation?.length) {
      collectedLines.push(`- Room distribution: ${body.roomAllocation.join(" + ")} (${body.roomAllocation.length} room${body.roomAllocation.length === 1 ? "" : "s"})`)
    }
    if (body.guestFirstName) {
      collectedLines.push(`- Guest name: ${body.guestFirstName}`)
    }
    const collectedSummary = collectedLines.length
      ? collectedLines.join("\n")
      : "- (nothing collected yet)"

    // Full Ava persona replaces the minimal "you are Ava" blurb.
    const personaBlock = SALES_PERSONA

    // Conversation transcript. Truth-source for what's been discussed —
    // the structured profile extractor is lossy, so the LLM should trust
    // the transcript first.
    let transcriptBlock = ""
    if (body.conversationHistory?.length) {
      const lines = body.conversationHistory.map((m) => {
        const speaker = m.role === "avatar" ? "Avatar" : "Guest"
        return `${speaker}: ${m.text}`
      })
      transcriptBlock = `\n\n## Conversation so far\n${lines.join("\n")}`
    }

    // Guest intelligence (personality, preferences, loyalty) is only useful
    // when we have an identity to anchor it. Without identity we skip the
    // block entirely — the fallback generic prompt is fine for cold starts.
    let intelligenceBlock = ""
    if (body.identity && (body.personality || body.preferences || body.loyalty)) {
      intelligenceBlock = `\n\n${buildGuestIntelligenceBlock({
        identity: body.identity,
        personality: body.personality ?? null,
        preferences: body.preferences ?? null,
        loyalty: body.loyalty ?? null,
      })}`
    }

    profileCollectionBlock = `\n\n## PROFILE_COLLECTION

${personaBlock}${intelligenceBlock}${transcriptBlock}

### Source of truth
Look at the conversation history above. Identify what the guest has ALREADY told you, even if the structured profile data below doesn't reflect it — the extractor sometimes misses things. Never ask about something the guest already mentioned. If the guest has implicitly answered a field (e.g., "we're a family" implies travel purpose = family vacation; "the two of us" implies 2 adults, 0 children), accept it and move on. Then determine what is still missing from the four required fields and ask about the next one in priority order. The structured fields (partySize, guestComposition, etc.) and \`profileAwaiting\` below are HINTS, not authority — the conversation is the source of truth.

Never ask the guest to confirm something they already said. If a field appears in "Already collected" or anywhere in the conversation history, treat it as definitively captured — acknowledge it on transition, but never re-verify it with a question.

### Required fields (collect in this priority order)
1. **Travel dates** — when the guest plans to travel
2. **Guest composition** — total party size, broken down into adults vs children
3. **Travel purpose** — why they are traveling (romantic getaway, family vacation, business, celebration, etc.)
4. **Room distribution** — how to split the guests across rooms (only relevant when party size > 1)

### What is missing
\`profileAwaiting\` tells you what is still needed:
- "dates_and_guests" — need both travel dates and guest count
- "dates" — need travel dates
- "guests" — need total guest count
- "guest_breakdown" — need adults vs children split
- "travel_purpose" — need why they are traveling
- "room_distribution" — need how to split guests across rooms
- "ready" — all required fields are collected

Current profileAwaiting: ${body.profileAwaiting ?? "unknown"}

### Already collected
${collectedSummary}

### Conversation style
- Keep responses to 1-2 sentences per turn, 3 max. Spoken aloud, not typed.
- Sound like a real person, not a chatbot. Use natural filler words occasionally ("Let's see...", "Oh, that's lovely").
- Ask ONE thing at a time. Never list multiple questions in a single turn.

### When asking about a missing field (no_action_speak)
- Ask directly about the missing field. Do NOT preface with "Got it," "Great," "Perfect," or any restatement of captured values. Do NOT ask the guest to confirm anything they already said — values in "Already collected" and the conversation history are definitive, not provisional.
- 1-2 sentences max.

### When transitioning to the hotel (navigate_and_speak with TRAVEL_TO_HOTEL)
- Produce a warm, concise handoff that restates 2-4 of the captured details to make the transition feel personal. Example: "Lovely — March 15 to 20, the four of you, a family trip split two and two. Let me take you to the lounge."
- 1-2 sentences. Never the same phrasing twice, never robotic.

- If the guest goes off-topic or asks unrelated questions, answer briefly (one short sentence) and redirect naturally to the next missing field. Examples:
  - "That sounds lovely — and just so I can get everything ready for you, when were you thinking of visiting?"
  - "Great question — I'll make a note. By the way, how many of you will be traveling?"
  - "Absolutely. And what's the occasion for this trip — leisure, business, something special?"
- Warm luxury concierge tone — observant and proactive, not robotic, not overly enthusiastic.
- Do NOT invent hotel facts, room names, prices, or amenities not provided in the guest context.
- Do NOT ask for firstName, lastName, email, phone, or date of birth — those are already known.

### Tool selection
- If \`profileAwaiting === "ready"\` OR the guest clearly wants to advance ("let's go", "I'm ready", "take me to the hotel", "let's continue") → return **navigate_and_speak** with \`intent: "TRAVEL_TO_HOTEL"\` and a brief transition speech.
- Otherwise → return **no_action_speak** with the next follow-up question.
- Do NOT use adjust_room_plan during PROFILE_COLLECTION — room planning happens later.`
  }

  return `You are Ava, an AI concierge for a luxury hotel metaverse experience. Given a user message and journey context, you must do TWO things in a single call: (1) classify what the user wants, and (2) generate a natural spoken response.

Call exactly one of the provided tools.

## Intent Classification Rules

Classify the user's intent into exactly one of these categories:

- **ROOMS**: User wants to see rooms, suites, or accommodation options.
- **AMENITIES**: User wants to see the list of amenities or facilities (generic request).
- **AMENITY_BY_NAME**: User mentions or refers to a specific amenity (pool, spa, restaurant, lobby, conference, gym, bar, lounge, dining) — including paraphrases like "swimming area" → pool, "eat" / "food" → restaurant, "work out" → gym. You MUST also return the canonical amenity name (one of: pool, spa, restaurant, lobby, conference, gym, bar, lounge, dining) in the "amenityName" field.
- **LOCATION**: User wants to see the hotel location, surroundings, neighbourhood, or area.
- **INTERIOR**: User wants to see the interior / inside view of a room or space.
- **EXTERIOR**: User wants to see the exterior / outside view of a room or space.
- **BACK**: User wants to go back, return to a previous view, or cancel current action.
- **HOTEL_EXPLORE**: User wants a general overview / tour of the hotel property (bird's eye view, zoom out, explore the hotel).
- **DOWNLOAD_DATA**: User explicitly requests to download their user data.
- **BOOK**: User wants to book, reserve, or proceed with a reservation.
- **AFFIRMATIVE**: User agrees, says yes, confirms, or accepts a proposal.
- **NEGATIVE**: User declines, says no, refuses, or rejects a proposal.
- **TRAVEL_TO_HOTEL**: User wants to proceed to the hotel building itself (NOT a specific room or amenity within it). Typically used when leaving the lounge. Examples: "I'm ready", "let's go", "take me to the hotel", "let's continue". If the user says "take me to the [specific amenity]" (e.g., "take me to the pool"), that is AMENITY_BY_NAME, not TRAVEL_TO_HOTEL.
- **OTHER_OPTIONS**: User wants to see other options, alternatives, or something different.
- **ROOM_TOGETHER**: User wants guests to share rooms or stay together.
- **ROOM_SEPARATE**: User wants separate / individual rooms for guests.
- **ROOM_AUTO**: User wants the system to decide room distribution (e.g., "you decide", "whatever works").
- **ROOM_PLAN_CHEAPER**: User wants a cheaper / more affordable room plan.
- **ROOM_PLAN_COMPACT**: User wants fewer rooms / a more compact room arrangement.
- **RETURN_TO_LOUNGE**: User wants to go back to the virtual lounge / lobby / gallery.
- **END_EXPERIENCE**: User wants to end the session, say goodbye, or leave.
- **UNKNOWN**: The message does not match any of the above intents.

### Intent Disambiguation Rules

1. **Do NOT resolve AFFIRMATIVE / NEGATIVE contextually.** If the user says "yes", "sure", "no thanks", etc. without mentioning a specific feature, return AFFIRMATIVE or NEGATIVE. The journey state machine handles context resolution (lastProposal, suggestedNext) — the classifier must not duplicate that logic.
2. Only return AMENITY_BY_NAME when the user's message itself references a specific amenity. A bare "yes" with a suggestedAmenityName in context is still AFFIRMATIVE.
3. Use UNKNOWN only when the message genuinely does not map to any intent.
4. **AMENITY_BY_NAME takes priority over TRAVEL_TO_HOTEL.** If the message mentions a specific amenity or facility ("take me to the pool", "go to the lobby", "let's visit the conference room"), classify as AMENITY_BY_NAME, not TRAVEL_TO_HOTEL. TRAVEL_TO_HOTEL only applies when the destination is "the hotel" generically.
${hasRooms ? `
## Room Plan Classification Rules

When the user's message is about room selection or planning, use the \`adjust_room_plan\` tool instead of \`navigate_and_speak\`. The action field must be one of:

- **adjust_budget**: User wants cheaper/more affordable rooms, or mentions a specific price target (e.g., "around $400 total", "something cheaper"). Include target_per_night in params if they mention a number.
- **set_room_composition**: User names specific rooms and/or quantities (e.g., "penthouse for us and a standard for the nanny", "two loft suites"). Use room IDs from the catalog above — never invent IDs. When the user says a room type generically (e.g., "a standard"), pick the cheapest matching room ID.
- **compact_plan**: User wants fewer rooms or to fit everyone together (e.g., "can we fit into one room", "fewer rooms"). Include max_rooms in params if they specify a number.
- **set_distribution**: User specifies how to split guests across rooms (e.g., "adults in one room and kids in another"). Return allocation as an array of guest counts per room in params.
- **recompute_with_preferences**: User has a preference for room type, view, or style but isn't naming exact rooms (e.g., "I'd prefer a lake view", "something more spacious").
- **no_room_change**: The message is NOT about room plan adjustments at all.

### Room Plan Rules

1. You MUST use room IDs from the provided catalog for set_room_composition. Never invent room IDs.
2. When the user mentions a dollar amount, that is the target total per night, not per room.
3. If the message is ambiguous between two actions, prefer the more specific one (set_room_composition > recompute_with_preferences > adjust_budget).
4. If the message has nothing to do with room selection or planning, do NOT use adjust_room_plan — use navigate_and_speak or no_action_speak instead.
` : ""}
## Speech Generation Rules

Every tool call MUST include a "speech" field — a natural spoken response for the avatar to say aloud.

1. Generate speech that is personal and contextual — not a generic template.
2. Preserve all room names, monetary amounts, and quantities VERBATIM. For example, if referring to "$398" or "Standard Mountain View", those exact strings must appear in your output.
3. Keep to 1-3 sentences max. This is spoken aloud by an avatar, not typed.
4. Use the guest's name sparingly — not every response. Vary whether you include it.
5. Reference the guest's last message or preferences when it feels natural, but don't force it.
6. Do NOT invent hotel facts, room names, prices, or amenities not given in the context.
7. Warm luxury concierge tone — not robotic, not overly enthusiastic. Think: a thoughtful host who remembers your preferences.

## Tool Selection

- Use **navigate_and_speak** for navigation intents (ROOMS, BACK, AMENITY_BY_NAME, AFFIRMATIVE, NEGATIVE, TRAVEL_TO_HOTEL, etc.) and other non-room-plan intents.${hasRooms ? "\n- Use **adjust_room_plan** for room plan requests (budget changes, room composition, distribution, preferences)." : ""}
- Use **no_action_speak** when the message doesn't map to any navigation or room plan action — just generate a helpful spoken response.${roomBlock}${guestBlock}${profileCollectionBlock}`
}

// ---------------------------------------------------------------------------
// OpenAI function-calling tool definitions
// ---------------------------------------------------------------------------

interface OpenAITool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

function buildTools(hasRooms: boolean, includeAdjustRoomPlan = true) {
  const tools: OpenAITool[] = [
    {
      type: "function" as const,
      function: {
        name: "navigate_and_speak",
        description: "Classify a navigation intent and generate speech",
        parameters: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              enum: INTENT_VALUES,
              description: "The classified navigation intent",
            },
            amenityName: {
              type: "string",
              description: "The canonical amenity name, required when intent is AMENITY_BY_NAME (one of: pool, spa, restaurant, lobby, conference, gym, bar, lounge, dining)",
            },
            speech: {
              type: "string",
              description: "Natural spoken response for the avatar (1-3 sentences, preserve all room names, amounts, and quantities verbatim)",
            },
          },
          required: ["intent", "speech"],
        },
      },
    },
  ]

  if (hasRooms && includeAdjustRoomPlan) {
    tools.push({
      type: "function" as const,
      function: {
        name: "adjust_room_plan",
        description: "Classify a room plan adjustment and generate speech",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "adjust_budget",
                "set_room_composition",
                "compact_plan",
                "set_distribution",
                "recompute_with_preferences",
                "no_room_change",
              ],
              description: "The room plan action to take",
            },
            target_per_night: {
              type: "number",
              description: "For adjust_budget: the user's target total price per night in dollars. Omit for other actions.",
            },
            rooms: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  room_id: { type: "string", description: "Room ID from the catalog" },
                  quantity: { type: "number", description: "Number of this room type" },
                },
                required: ["room_id", "quantity"],
              },
              description: "For set_room_composition: array of rooms and quantities. Omit for other actions.",
            },
            max_rooms: {
              type: "number",
              description: "For compact_plan: maximum rooms the user wants. Omit for other actions.",
            },
            allocation: {
              type: "array",
              items: { type: "number" },
              description: "For set_distribution: guest counts per room, e.g. [2, 2]. Omit for other actions.",
            },
            budget_range: {
              type: "string",
              description: "For recompute_with_preferences: budget preference if mentioned. Omit for other actions.",
            },
            distribution_preference: {
              type: "string",
              description: "For recompute_with_preferences: 'together', 'separate', or 'auto'. Omit for other actions.",
            },
            room_type_preference: {
              type: "string",
              description: "For recompute_with_preferences: preferred room type or view. Omit for other actions.",
            },
            speech: {
              type: "string",
              description: "Natural spoken response for the avatar (1-3 sentences, preserve all room names, amounts, and quantities verbatim)",
            },
          },
          required: ["action", "speech"],
        },
      },
    })
  }

  tools.push({
    type: "function" as const,
    function: {
      name: "no_action_speak",
      description: "No navigation or room plan action — just generate a helpful spoken response",
      parameters: {
        type: "object",
        properties: {
          speech: {
            type: "string",
            description: "Natural spoken response for the avatar (1-3 sentences)",
          },
        },
        required: ["speech"],
      },
    },
  })

  return tools
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY

  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: "Orchestration not configured", code: "NOT_CONFIGURED" }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    const body = (await request.json()) as RequestBody

    if (!body.message || typeof body.message !== "string") {
      return new Response(
        JSON.stringify({ error: "message string is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    if (!body.journeyContext) {
      return new Response(
        JSON.stringify({ error: "journeyContext is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const hasRooms = !!(body.rooms && body.rooms.length > 0)
    const isProfileCollection = body.journeyContext.stage === "PROFILE_COLLECTION"
    const systemPrompt = buildSystemPrompt(body)
    const tools = buildTools(hasRooms, !isProfileCollection)

    // Build journey context block for user message
    const jc = body.journeyContext
    let journeyBlock = `\n\nJourney context:\n- Stage: ${jc.stage}`
    if (jc.subState) journeyBlock += `\n- Sub-state: ${jc.subState}`
    if (jc.lastProposal) journeyBlock += `\n- Last avatar proposal: ${jc.lastProposal}`
    if (jc.suggestedAmenityName) journeyBlock += `\n- Suggested amenity: ${jc.suggestedAmenityName}`
    if (jc.suggestedNext) journeyBlock += `\n- Suggested next amenity: ${jc.suggestedNext}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 7000)

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
            { role: "system", content: systemPrompt },
            { role: "user", content: `User message: "${body.message}"${journeyBlock}` },
          ],
          temperature: 0.3,
          tools,
          tool_choice: "auto",
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error("OpenAI API error:", errorData)
        return new Response(
          JSON.stringify({ error: "Failed to orchestrate" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const data = await response.json()
      const toolCall = data.choices?.[0]?.message?.tool_calls?.[0]
      const functionName = toolCall?.function?.name
      const args = toolCall?.function?.arguments

      if (!functionName || args === undefined) {
        return new Response(
          JSON.stringify({ error: "No tool call in AI response" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const schema = TOOL_SCHEMAS[functionName]
      if (!schema) {
        return new Response(
          JSON.stringify({ error: `Unknown tool: ${functionName}` }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const parsed = JSON.parse(args)
      const validated = schema.safeParse(parsed)

      if (!validated.success) {
        console.error("Schema validation failed:", validated.error)
        return new Response(
          JSON.stringify({ error: "Invalid orchestration structure" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      // Note: adjust_room_plan params are validated loosely here.
      // The downstream executeRoomPlanAction handles missing/malformed params
      // gracefully via optional chaining and fallback logic.

      // Build response
      const result = validated.data as Record<string, unknown>
      const responseBody: Record<string, unknown> = { tool: functionName }

      if (functionName === "navigate_and_speak") {
        responseBody.intent = result.intent
        if (result.amenityName) responseBody.amenityName = result.amenityName
        responseBody.speech = result.speech
      } else if (functionName === "adjust_room_plan") {
        responseBody.action = result.action
        // Pack flat fields back into a params object for the client
        responseBody.params = {
          target_per_night: result.target_per_night,
          rooms: result.rooms,
          max_rooms: result.max_rooms,
          allocation: result.allocation,
          budget_range: result.budget_range,
          distribution_preference: result.distribution_preference,
          room_type_preference: result.room_type_preference,
        }
        responseBody.speech = result.speech
      } else {
        // no_action_speak
        responseBody.speech = result.speech
      }

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === "AbortError") {
        return new Response(
          JSON.stringify({ error: "Orchestration timed out" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }
      throw err
    }
  } catch (error) {
    console.error("Orchestration error:", error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )
  }
}
