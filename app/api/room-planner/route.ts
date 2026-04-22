import { z } from "zod"
import {
  getHotelBySlug,
  getRoomsByHotelId,
  type Room,
} from "@/lib/hotel-data"

// ---------------------------------------------------------------------------
// Room Planner — Phase 1
//
// Dedicated LLM endpoint that produces the room plan the RoomsPanel displays,
// driven by conversation history + the hotel's room catalog. Two triggers:
//   (1) rooms panel opens  → `trigger: "panel_opened"`
//   (2) user sends a room-edit voice message while the panel is open
//       → `trigger: "user_message"`
//
// Mirrors the patterns used in `/api/orchestrate/route.ts`:
//   - `NEXT_PUBLIC_OPENAI_API_KEY` guard → 501
//   - Zod-validated request body
//   - AbortController with a 15s timeout
//   - Single tool-call (`propose_room_plan`) with strict schema
//   - Server re-fetches the catalog from `lib/hotel-data.ts` — the client
//     never supplies it
//   - One `[ROOM_PLANNER]` log per request
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ProfileSchema = z
  .object({
    partySize: z.number().int().positive().optional(),
    guestComposition: z
      .object({
        adults: z.number().int().nonnegative(),
        children: z.number().int().nonnegative(),
        childrenAges: z.array(z.number().int().nonnegative()).optional(),
      })
      .optional(),
    travelPurpose: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    budgetRange: z.string().optional(),
  })
  .partial()

const PlanEntrySchema = z.object({
  roomId: z.string(),
  quantity: z.number().int().positive(),
})

const RequestBodySchema = z.object({
  hotelSlug: z.string().min(1),
  profile: ProfileSchema,
  currentPlan: z.array(PlanEntrySchema).nullable(),
  transcript: z.array(
    z.object({
      role: z.enum(["user", "avatar"]),
      text: z.string(),
    }),
  ),
  trigger: z.enum(["panel_opened", "user_message"]),
  latestMessage: z.string().optional(),
})

type RequestBody = z.infer<typeof RequestBodySchema>

// ---------------------------------------------------------------------------
// Tool schema — `propose_room_plan`
// ---------------------------------------------------------------------------

const ProposePlanSchema = z.object({
  plan: z.array(PlanEntrySchema),
  speech: z.string().min(1).max(600),
})

type ProposePlanArgs = z.infer<typeof ProposePlanSchema>

const PROPOSE_ROOM_PLAN_TOOL = {
  type: "function" as const,
  function: {
    name: "propose_room_plan",
    description:
      "Propose the room plan to render in the rooms panel. Use roomIds from the provided catalog only; never invent IDs. Produce a short spoken response the avatar will say.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          description:
            "Rooms to display, each with a roomId (from catalog) and a positive quantity.",
          items: {
            type: "object",
            properties: {
              roomId: {
                type: "string",
                description: "Exact roomId from the provided catalog.",
              },
              quantity: {
                type: "number",
                description: "How many of this room type to include (positive integer).",
              },
            },
            required: ["roomId", "quantity"],
          },
        },
        speech: {
          type: "string",
          description:
            "1–3 sentences for the avatar to say. Reference the guest's concrete constraint; preserve room names and dollar amounts verbatim. Warm luxury concierge tone.",
        },
      },
      required: ["plan", "speech"],
    },
  },
}

// ---------------------------------------------------------------------------
// Catalog rendering — forward-compatible with new fields
//
// We format every room object as "key: value" lines so the model sees whatever
// fields exist on the Room type at call time (area, beds, AC, terrace, etc.
// once they're added). `image` is intentionally hidden since it's a UI asset.
// ---------------------------------------------------------------------------

const CATALOG_FIELD_BLACKLIST = new Set<string>(["image"])

function renderRoomCatalog(hotelRooms: Room[]): string {
  if (hotelRooms.length === 0) return "(no rooms available)"
  return hotelRooms
    .map((room) => {
      const entries: string[] = []
      for (const [key, value] of Object.entries(room)) {
        if (CATALOG_FIELD_BLACKLIST.has(key)) continue
        if (value === undefined || value === null) continue
        if (typeof value === "object") {
          entries.push(`${key}: ${JSON.stringify(value)}`)
        } else {
          entries.push(`${key}: ${String(value)}`)
        }
      }
      return `- ${entries.join(", ")}`
    })
    .join("\n")
}

function renderProfile(profile: RequestBody["profile"]): string {
  const lines: string[] = []
  if (profile.partySize) lines.push(`- Party size: ${profile.partySize}`)
  if (profile.guestComposition) {
    const gc = profile.guestComposition
    const agesSuffix = gc.childrenAges?.length
      ? ` (ages ${gc.childrenAges.join(", ")})`
      : ""
    lines.push(
      `- Guest composition: ${gc.adults} adults, ${gc.children} children${agesSuffix}`,
    )
  }
  if (profile.travelPurpose) lines.push(`- Travel purpose: ${profile.travelPurpose}`)
  if (profile.startDate && profile.endDate) {
    lines.push(`- Dates: ${profile.startDate} to ${profile.endDate}`)
  } else if (profile.startDate) {
    lines.push(`- Start date: ${profile.startDate}`)
  } else if (profile.endDate) {
    lines.push(`- End date: ${profile.endDate}`)
  }
  if (profile.budgetRange) lines.push(`- Budget: ${profile.budgetRange}`)
  return lines.length ? lines.join("\n") : "- (no profile details yet)"
}

function renderCurrentPlan(
  currentPlan: RequestBody["currentPlan"],
  hotelRooms: Room[],
): string {
  if (!currentPlan || currentPlan.length === 0) {
    return "- (no current plan — this is a fresh recommendation)"
  }
  const byId = new Map(hotelRooms.map((r) => [r.id, r]))
  return currentPlan
    .map((entry) => {
      const room = byId.get(entry.roomId)
      const label = room ? `${room.name} ($${room.price}/night)` : entry.roomId
      return `- ${entry.quantity}x ${label} (roomId: ${entry.roomId})`
    })
    .join("\n")
}

function renderTranscript(transcript: RequestBody["transcript"]): string {
  if (transcript.length === 0) return "(no conversation yet)"
  return transcript
    .map((m) => `${m.role === "avatar" ? "Avatar" : "Guest"}: ${m.text}`)
    .join("\n")
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  body: RequestBody,
  hotelName: string,
  hotelRooms: Room[],
): string {
  const catalogBlock = renderRoomCatalog(hotelRooms)
  const profileBlock = renderProfile(body.profile)
  const currentPlanBlock = renderCurrentPlan(body.currentPlan, hotelRooms)
  const transcriptBlock = renderTranscript(body.transcript)

  const triggerBlock =
    body.trigger === "panel_opened"
      ? `## Trigger: panel_opened

The rooms panel just became visible. Produce a FRESH recommendation based on the transcript and the guest profile. Read the conversation for any constraints the guest already voiced (view type, budget, specific rooms mentioned, room count preference, distribution like "adults in one, kids in another"). If the transcript hasn't surfaced a specific preference, choose a sensible default plan: cover the party size with the fewest rooms that fit the travel purpose (family/honeymoon → pack together; business → spread).`
      : `## Trigger: user_message

The guest just spoke while the rooms panel was open. Treat the latest message as an EDIT to \`currentPlan\` — add, remove, replace, clear, or filter. Do NOT rebuild from scratch unless the guest explicitly said "start over", "clear the list", "reset", or equivalent. If the guest asked for something already satisfied, return the current plan unchanged (and say so briefly).${body.latestMessage ? `\n\nLatest guest message: "${body.latestMessage}"` : ""}`

  return `You are Ava's room-planning brain for a luxury hotel concierge experience at ${hotelName}. Your single job is to decide which rooms appear in the rooms panel and what the avatar says about them.

Call exactly one tool: \`propose_room_plan\`.

## Hard rules — violating these breaks the UI

1. Only use \`roomId\` values that appear in the catalog below. Never invent IDs. The server will reject unknown IDs.
2. Each plan entry has a positive integer \`quantity\`.
3. Total occupancy across the plan should be ≥ party size. If the guest EXPLICITLY asks for something that undercapacities (e.g., "just one standard" for 6 guests), you may honor it — but you MUST note it in speech ("That sleeps 2 — we'd still need room for 4 more. Want me to add one?"). Never silently under-provision.
4. Every field on a room object in the catalog is available to you — name, price, occupancy, and any additional attributes (view, beds, bathrooms, area, AC, terrace, description, etc.). Filter on whichever field the guest asked for. Do not invent attributes that aren't in the catalog.
5. Preserve room names and dollar amounts VERBATIM in speech. If a room is "Standard Mountain View" at $199, speak those exact strings.
6. Warm luxury concierge tone — not robotic, not gushing. 1–3 sentences max; it will be spoken aloud by an avatar.
7. Reference the guest's concrete constraint in speech ("since you mentioned a lake view", "keeping the kids in the connecting loft"). No generic templates.

## Hotel
${hotelName}

## Available rooms
${catalogBlock}

## Guest profile
${profileBlock}

## Current plan (what's on screen right now)
${currentPlanBlock}

## Conversation so far
${transcriptBlock}

${triggerBlock}

## How to respond

- Call \`propose_room_plan\` with:
  - \`plan\`: the full list of rooms to display, each \`{ roomId, quantity }\`. This REPLACES what's on screen — if the guest asked to add one Penthouse on top of the current plan, include BOTH the existing entries and the new one in your \`plan\`.
  - \`speech\`: what the avatar says aloud, 1–3 sentences, referencing the guest's constraint concretely and preserving names/prices verbatim.`
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY

  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: "Room planner not configured", code: "NOT_CONFIGURED" }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    )
  }

  const requestStart = Date.now()
  try {
    const raw = await request.json()
    const parsed = RequestBodySchema.safeParse(raw)
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "Invalid request body", details: parsed.error.flatten() }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }
    const body = parsed.data

    // --- Catalog lookup (server-only — never accept catalog from the client) ---
    const hotel = getHotelBySlug(body.hotelSlug)
    if (!hotel) {
      return new Response(
        JSON.stringify({ error: `Unknown hotelSlug: ${body.hotelSlug}` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }
    const hotelRooms = getRoomsByHotelId(hotel.id)
    const validRoomIds = new Set(hotelRooms.map((r) => r.id))

    const systemPrompt = buildSystemPrompt(body, hotel.name, hotelRooms)
    const latestMessageLine = body.latestMessage
      ? `Latest guest message: "${body.latestMessage}"`
      : `Trigger: ${body.trigger}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: latestMessageLine },
          ],
          temperature: 0.2,
          tools: [PROPOSE_ROOM_PLAN_TOOL],
          tool_choice: {
            type: "function",
            function: { name: "propose_room_plan" },
          },
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error("[ROOM_PLANNER_ERROR] OpenAI API error:", errorData)
        return new Response(
          JSON.stringify({ error: "Failed to plan rooms" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const data = await response.json()
      const toolCall = data.choices?.[0]?.message?.tool_calls?.[0]
      const functionName = toolCall?.function?.name
      const args = toolCall?.function?.arguments

      if (functionName !== "propose_room_plan" || args === undefined) {
        console.error("[ROOM_PLANNER_ERROR] missing or unexpected tool_call:", functionName)
        return new Response(
          JSON.stringify({ error: "No tool call in AI response" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      let parsedArgs: unknown
      try {
        parsedArgs = JSON.parse(args)
      } catch (err) {
        console.error("[ROOM_PLANNER_ERROR] JSON parse failed:", err)
        return new Response(
          JSON.stringify({ error: "Malformed tool arguments" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const validated = ProposePlanSchema.safeParse(parsedArgs)
      if (!validated.success) {
        console.error("[ROOM_PLANNER_ERROR] schema validation:", validated.error.flatten())
        return new Response(
          JSON.stringify({ error: "Invalid plan structure" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }

      const result: ProposePlanArgs = validated.data

      // --- Validate every roomId exists in the catalog ---
      const unknownIds: string[] = []
      for (const entry of result.plan) {
        if (!validRoomIds.has(entry.roomId)) unknownIds.push(entry.roomId)
      }
      if (unknownIds.length > 0) {
        console.error("[ROOM_PLANNER_ERROR] LLM returned unknown roomIds:", unknownIds)
        return new Response(
          JSON.stringify({
            error: "LLM proposed unknown roomIds",
            unknownIds,
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        )
      }

      // --- Server computes totals + capacity check ---
      const roomById = new Map(hotelRooms.map((r) => [r.id, r]))
      let totalPerNight = 0
      let capacity = 0
      for (const entry of result.plan) {
        const room = roomById.get(entry.roomId)!
        totalPerNight += room.price * entry.quantity
        const occ = parseInt(room.occupancy, 10)
        const safeOcc = Number.isFinite(occ) && occ > 0 ? occ : 0
        capacity += safeOcc * entry.quantity
      }
      const partySize = body.profile.partySize ?? 0
      const capacityOk = partySize > 0 ? capacity >= partySize : true

      const responseBody = {
        plan: result.plan,
        speech: result.speech,
        totalPerNight,
        capacityOk,
      }

      console.log(
        "[ROOM_PLANNER]",
        JSON.stringify({
          hotelSlug: body.hotelSlug,
          trigger: body.trigger,
          latestMessage: body.latestMessage,
          latencyMs: Date.now() - requestStart,
          planSize: result.plan.length,
          totalPerNight,
          capacityOk,
          outSpeech: result.speech,
        }),
      )

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    } catch (err) {
      clearTimeout(timeout)
      if ((err as Error).name === "AbortError") {
        console.error("[ROOM_PLANNER_ERROR] timed out")
        return new Response(
          JSON.stringify({ error: "Room planner timed out" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        )
      }
      throw err
    }
  } catch (error) {
    console.error("[ROOM_PLANNER_ERROR]", error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )
  }
}
