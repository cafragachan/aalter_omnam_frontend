import { z } from "zod"

// ---------------------------------------------------------------------------
// Zod schemas for each tool's parameters
// ---------------------------------------------------------------------------

const AdjustBudgetSchema = z.object({
  target_per_night: z.number().optional(),
})

const SetRoomCompositionSchema = z.object({
  rooms: z.array(z.object({ room_id: z.string(), quantity: z.number() })),
})

const CompactPlanSchema = z.object({
  max_rooms: z.number().optional(),
})

const SetDistributionSchema = z.object({
  allocation: z.array(z.number()),
})

const RecomputeWithPreferencesSchema = z.object({
  budget_range: z.string().optional(),
  distribution_preference: z.string().optional(),
  room_type_preference: z.string().optional(),
})

const NoRoomChangeSchema = z.object({})

const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  adjust_budget: AdjustBudgetSchema,
  set_room_composition: SetRoomCompositionSchema,
  compact_plan: CompactPlanSchema,
  set_distribution: SetDistributionSchema,
  recompute_with_preferences: RecomputeWithPreferencesSchema,
  no_room_change: NoRoomChangeSchema,
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

interface RequestBody {
  message: string
  rooms: RoomInfo[]
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
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(body: RequestBody): string {
  const roomCatalog = body.rooms
    .map((r) => `  - ${r.name} (id: "${r.id}", occupancy: ${r.occupancy}, price: $${r.price}/night)`)
    .join("\n")

  const currentPlanBlock = body.currentPlan
    ? `\nCurrent room plan:\n${body.currentPlan.entries.map((e) => `  - ${e.quantity}x ${e.roomName} @ $${e.pricePerNight}/night`).join("\n")}\n  Total: $${body.currentPlan.totalPricePerNight}/night`
    : ""

  const partySizeBlock = body.partySize ? `\nParty size: ${body.partySize} guests` : ""

  const guestBlock = body.guestComposition
    ? `\nGuest composition: ${body.guestComposition.adults} adults, ${body.guestComposition.children} children`
    : ""

  const budgetBlock = body.budgetRange ? `\nBudget range: ${body.budgetRange}` : ""

  const purposeBlock = body.travelPurpose ? `\nTravel purpose: ${body.travelPurpose}` : ""

  return `You are a room plan classifier for a luxury hotel AI concierge.

Given a user message and context about their stay, determine what room plan adjustment (if any) the user is requesting. Call exactly one of the provided tools.

## Available rooms

${roomCatalog}
${partySizeBlock}${guestBlock}${currentPlanBlock}${budgetBlock}${purposeBlock}

## Tool selection rules

- **adjust_budget**: User wants cheaper/more affordable rooms, or mentions a specific price target (e.g., "around $400 total", "something cheaper"). Include target_per_night if they mention a number.
- **set_room_composition**: User names specific rooms and/or quantities (e.g., "penthouse for us and a standard for the nanny", "two loft suites"). Use room IDs from the list above — never invent IDs. When the user says a room type generically (e.g., "a standard"), pick the cheapest matching room ID.
- **compact_plan**: User wants fewer rooms or to fit everyone together (e.g., "can we fit into one room", "fewer rooms"). Include max_rooms if they specify a number.
- **set_distribution**: User specifies how to split guests across rooms (e.g., "adults in one room and kids in another"). Return allocation as an array of guest counts per room.
- **recompute_with_preferences**: User has a preference for room type, view, or style but isn't naming exact rooms (e.g., "I'd prefer a lake view", "something more spacious").
- **no_room_change**: The message is NOT about room plan adjustments at all (e.g., "what time is checkout", "tell me about the spa").

## Important rules

1. You MUST use room IDs from the provided list for set_room_composition. Never invent room IDs.
2. When the user mentions a dollar amount, that is the target total per night, not per room.
3. If the message is ambiguous between two tools, prefer the more specific one (set_room_composition > recompute_with_preferences > adjust_budget).
4. If the message has nothing to do with room selection or planning, use no_room_change.`
}

// ---------------------------------------------------------------------------
// OpenAI function-calling tool definitions
// ---------------------------------------------------------------------------

const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "adjust_budget",
      description: "User wants a cheaper plan or mentions a specific price target",
      parameters: {
        type: "object",
        properties: {
          target_per_night: {
            type: "number",
            description: "Target total price per night in dollars, if the user mentioned one",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_room_composition",
      description: "User names specific rooms and quantities",
      parameters: {
        type: "object",
        properties: {
          rooms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                room_id: { type: "string", description: "Room ID from the provided catalog" },
                quantity: { type: "number", description: "Number of this room type" },
              },
              required: ["room_id", "quantity"],
            },
            description: "List of rooms and quantities",
          },
        },
        required: ["rooms"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "compact_plan",
      description: "User wants fewer rooms or to fit everyone together",
      parameters: {
        type: "object",
        properties: {
          max_rooms: {
            type: "number",
            description: "Maximum number of rooms the user wants, if specified",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_distribution",
      description: "User specifies how to split guests across rooms",
      parameters: {
        type: "object",
        properties: {
          allocation: {
            type: "array",
            items: { type: "number" },
            description: "Array of guest counts per room",
          },
        },
        required: ["allocation"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recompute_with_preferences",
      description: "User has a room type, view, or style preference",
      parameters: {
        type: "object",
        properties: {
          budget_range: {
            type: "string",
            description: "Budget preference if mentioned (e.g., 'mid-range', 'luxury')",
          },
          distribution_preference: {
            type: "string",
            description: "How guests should be distributed if mentioned",
          },
          room_type_preference: {
            type: "string",
            description: "Preferred room type or view (e.g., 'lake view', 'suite', 'spacious')",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "no_room_change",
      description: "The message is not about room plan adjustments",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY

  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: "AI classification not configured", code: "NOT_CONFIGURED" }),
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

    if (!body.rooms || !Array.isArray(body.rooms) || body.rooms.length === 0) {
      return new Response(
        JSON.stringify({ error: "rooms array is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const systemPrompt = buildSystemPrompt(body)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)

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
            { role: "user", content: `User message: "${body.message}"` },
          ],
          temperature: 0,
          tools: OPENAI_TOOLS,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error("OpenAI API error:", errorData)
        return new Response(
          JSON.stringify({ error: "Failed to classify room plan" }),
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
          JSON.stringify({ error: "Invalid classification structure" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response(
        JSON.stringify({ action: functionName, params: validated.data }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === "AbortError") {
        return new Response(
          JSON.stringify({ error: "Classification timed out" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }
      throw err
    }
  } catch (error) {
    console.error("Room plan classification error:", error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )
  }
}
