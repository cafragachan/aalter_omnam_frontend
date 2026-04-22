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

// profile_turn — used only during PROFILE_COLLECTION. The LLM owns
// extraction, next-question decision, and speech in a single tool call.
const ProfileUpdatesSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  partySize: z.number().int().positive().optional(),
  guestComposition: z.object({
    adults: z.number().int().nonnegative().optional(),
    children: z.number().int().nonnegative().optional(),
    childrenAges: z.array(z.number().int().nonnegative()).optional(),
  }).optional(),
  travelPurpose: z.string().optional(),
  roomAllocation: z.array(z.number().int().positive()).optional(),
}).partial()

const ProfileTurnSchema = z.object({
  // reasoning comes first so the model is forced to think before emitting
  // structured decisions. We log it but don't route on it.
  reasoning: z.string().min(1).max(1000),
  profileUpdates: ProfileUpdatesSchema.optional().default({}),
  decision: z.enum(["ask_next", "clarify", "ready"]),
  speech: z.string().min(1).max(500),
})

const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  navigate_and_speak: NavigateAndSpeakSchema,
  adjust_room_plan: AdjustRoomPlanSchema,
  no_action_speak: NoActionSpeakSchema,
  profile_turn: ProfileTurnSchema,
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
  guestComposition?: { adults: number; children: number; childrenAges?: number[] }
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
  /**
   * Phase 3: the client's regex-classifier guess for this turn. When present
   * AND the stage is NOT PROFILE_COLLECTION AND the hint is not "UNKNOWN",
   * the system prompt surfaces it as a tiebreaker hint for the LLM. Unused
   * in PROFILE_COLLECTION (that stage uses the profile_turn tool, not
   * navigation intents).
   */
  regexHint?: string
}

// ---------------------------------------------------------------------------
// Server-side profile reconstruction from transcript (Phase 4)
//
// The client-sent body fields (partySize, guestComposition, travelPurpose,
// roomAllocation, dates) can be stale — the client's React state often lags
// behind the transcript because extraction is debounced / racy / spread
// across three stores. For every orchestrate call we reconcile a merged view
// the LLM can reason against so it can ignore a stale `body.partySize: 1`
// when the transcript clearly says "8 guests".
//
// This merged view is:
//   • logged as `reconstructedProfile` for observability
//   • rendered into the system prompt (at all stages when history is present)
//   • advisory to the LLM — the transcript always wins on disagreement
//
// The heavy lifting (transcript-aware structured extraction) is done by the
// LLM itself inside profile_turn (PROFILE_COLLECTION) or inline reasoning
// (other stages). This helper only assembles the client-sent fields into a
// canonical shape and adds a "transcriptHas" hint listing which fields the
// transcript appears to contain so the LLM knows what to re-extract. Server-
// side we don't do AI extraction here — that stays in profile_turn. For
// non-PROFILE_COLLECTION stages this is a "light reconciliation": we trust
// the body fields as a prior, but the prompt tells the LLM to correct them
// from transcript if they disagree.
// ---------------------------------------------------------------------------

type ReconstructedProfile = {
  startDate?: string
  endDate?: string
  partySize?: number
  guestComposition?: { adults: number; children: number; childrenAges?: number[] }
  travelPurpose?: string
  roomAllocation?: number[]
  guestFirstName?: string
  interests?: string[]
  budgetRange?: string
  /**
   * Simple keyword flags derived from transcript user turns. These are NOT
   * authoritative — the LLM always owns extraction. They exist so the prompt
   * can highlight "the transcript mentions X while body.X is unset/different;
   * trust the transcript" rather than silently letting a stale body win.
   */
  transcriptHints: {
    mentionsParty: boolean
    mentionsDates: boolean
    mentionsChildren: boolean
    mentionsPurpose: boolean
    mentionsRooms: boolean
  }
}

function reconstructProfileFromTranscript(
  history: { role: "user" | "avatar"; text: string }[] | undefined,
  clientBody: RequestBody,
): ReconstructedProfile {
  // Derive an "effective" partySize from guestComposition when the body's
  // partySize lags (matches the logic already in contextBlock / profile block).
  const compTotal = clientBody.guestComposition
    ? (clientBody.guestComposition.adults ?? 0) + (clientBody.guestComposition.children ?? 0)
    : 0
  const effectivePartySize = compTotal > 0 ? compTotal : clientBody.partySize

  // Scan user turns for simple keyword flags. These are signals for the LLM,
  // not decisions. The LLM owns canonical extraction; this just helps the
  // prompt say "hey, the transcript talks about kids but clientBody has
  // children=0 — re-check the transcript".
  const userTurns = (history ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.text.toLowerCase())
    .join(" | ")

  const mentionsParty =
    /\b(guests?|people|adults?|kids?|children|us|party|of\s+(?:two|three|four|five|six|seven|eight|nine|ten|\d+))\b/.test(
      userTurns,
    )
  const mentionsDates =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}(?:st|nd|rd|th)?|next\s+(?:week|month)|weekend|dates?|arriving|arrival|checkin|check-in)\b/.test(
      userTurns,
    )
  const mentionsChildren =
    /\b(kids?|child|children|son|daughter|toddlers?|babies|baby|teens?|teenagers?|ages?\s+\d|no\s+kids)\b/.test(
      userTurns,
    )
  const mentionsPurpose =
    /\b(honeymoon|anniversary|business|leisure|vacation|holiday|celebration|birthday|wedding|family|romantic|retreat|getaway|work|conference)\b/.test(
      userTurns,
    )
  const mentionsRooms =
    /\b(rooms?|suites?|together|separate|share|split|one\s+room|two\s+rooms|three\s+rooms|connecting)\b/.test(
      userTurns,
    )

  return {
    startDate: clientBody.startDate,
    endDate: clientBody.endDate,
    partySize: effectivePartySize,
    guestComposition: clientBody.guestComposition,
    travelPurpose: clientBody.travelPurpose,
    roomAllocation: clientBody.roomAllocation,
    guestFirstName: clientBody.guestFirstName,
    interests: clientBody.interests,
    budgetRange: clientBody.budgetRange,
    transcriptHints: {
      mentionsParty,
      mentionsDates,
      mentionsChildren,
      mentionsPurpose,
      mentionsRooms,
    },
  }
}

function renderReconstructedProfile(r: ReconstructedProfile): string {
  const lines: string[] = []
  if (r.startDate && r.endDate) {
    lines.push(`- Dates: ${r.startDate} to ${r.endDate}`)
  } else if (r.startDate) {
    lines.push(`- Start date: ${r.startDate} (end date missing)`)
  } else if (r.endDate) {
    lines.push(`- End date: ${r.endDate} (start date missing)`)
  }
  if (r.partySize) {
    lines.push(`- Party size: ${r.partySize} guest${r.partySize === 1 ? "" : "s"}`)
  }
  if (r.guestComposition) {
    const agesSuffix = r.guestComposition.childrenAges?.length
      ? ` (ages ${r.guestComposition.childrenAges.join(", ")})`
      : ""
    lines.push(
      `- Guest composition: ${r.guestComposition.adults} adults, ${r.guestComposition.children} children${agesSuffix}`,
    )
  }
  if (r.travelPurpose) lines.push(`- Travel purpose: ${r.travelPurpose}`)
  if (r.roomAllocation?.length) {
    lines.push(
      `- Room distribution: ${r.roomAllocation.join(" + ")} (${r.roomAllocation.length} room${r.roomAllocation.length === 1 ? "" : "s"})`,
    )
  }
  if (r.guestFirstName) lines.push(`- Guest name: ${r.guestFirstName}`)
  if (r.interests?.length) lines.push(`- Interests: ${r.interests.join(", ")}`)
  if (r.budgetRange) lines.push(`- Budget range: ${r.budgetRange}`)

  const hints: string[] = []
  if (r.transcriptHints.mentionsParty) hints.push("party size")
  if (r.transcriptHints.mentionsDates) hints.push("dates")
  if (r.transcriptHints.mentionsChildren) hints.push("children")
  if (r.transcriptHints.mentionsPurpose) hints.push("travel purpose")
  if (r.transcriptHints.mentionsRooms) hints.push("room distribution")

  const body = lines.length > 0 ? lines.join("\n") : "- (nothing reported by client yet)"
  const hintLine = hints.length > 0
    ? `\n- Transcript mentions: ${hints.join(", ")} — verify these against the block above; re-extract from the transcript if anything disagrees.`
    : ""
  return body + hintLine
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(body: RequestBody, reconstructed: ReconstructedProfile): string {
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
  // Derive party size from composition when the body's partySize lags behind
  // transcript-extracted composition (happens mid-session before client sync).
  const ctxCompTotal = body.guestComposition
    ? (body.guestComposition.adults ?? 0) + (body.guestComposition.children ?? 0)
    : 0
  const ctxPartySize = ctxCompTotal > 0 ? ctxCompTotal : body.partySize
  if (ctxPartySize) contextBlock += `\n- Party size: ${ctxPartySize} guests`
  if (body.guestComposition) {
    const agesSuffix = body.guestComposition.childrenAges?.length
      ? ` (ages ${body.guestComposition.childrenAges.join(", ")})`
      : ""
    contextBlock += `\n- Guest composition: ${body.guestComposition.adults} adults, ${body.guestComposition.children} children${agesSuffix}`
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
    // Prefer the sum of adults + children when guestComposition is richer than
    // a stale body.partySize (client state lags behind transcript extraction).
    const compTotal = body.guestComposition
      ? (body.guestComposition.adults ?? 0) + (body.guestComposition.children ?? 0)
      : 0
    const effectivePartySize = compTotal > 0 ? compTotal : body.partySize
    if (effectivePartySize) {
      collectedLines.push(`- Party size: ${effectivePartySize} guest${effectivePartySize === 1 ? "" : "s"}`)
    }
    if (body.guestComposition) {
      const agesSuffix = body.guestComposition.childrenAges?.length
        ? ` (ages ${body.guestComposition.childrenAges.join(", ")})`
        : ""
      collectedLines.push(`- Guest composition: ${body.guestComposition.adults} adults, ${body.guestComposition.children} children${agesSuffix}`)
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

    const today = new Date().toISOString().slice(0, 10)

    profileCollectionBlock = `\n\n## PROFILE_COLLECTION

${personaBlock}${intelligenceBlock}${transcriptBlock}

### ABSOLUTE RULES — violating these is worse than any other error

1. **NEVER invent data the guest didn't state.** If they said "between 12 and 16" for 4 children, you do NOT expand to [12, 13, 14, 15]. You set \`decision: "clarify"\`.
2. **NEVER set \`decision: "ready"\` unless EVERY required field is captured** (dates, partySize, guestComposition, childrenAges-if-children>0, travelPurpose, roomAllocation-if-partySize>1). If ANY one is missing, decision is \`"ask_next"\` or \`"clarify"\`.
3. **NEVER claim you've noted something you haven't verified.** "I've noted the ages as 12, 13, 14, 15" is a LIE if the guest only said "between 12 and 16". Ask for clarification instead.

A server validator will reject \`ready\` with missing fields and reject age lists whose length doesn't match child count. If you violate these, your response is overridden with a canned reask — do it right the first time.

### Your job each turn

Return exactly one \`profile_turn\` tool call. The transcript above is the source of truth — extract every profile field the guest has revealed across ALL their turns, not just the latest one. The "Current profile state" block below may be stale, partial, or outright wrong; always trust the transcript first.

\`profile_turn\` has four fields, produced in this order:

1. \`reasoning\` — REQUIRED. Write this FIRST. 2-5 sentences of internal monologue that answers: (a) what did the guest just say, (b) what does the current state show, (c) what is missing, (d) why is the decision and speech you are about to emit the correct one. This is not spoken aloud — it is a thinking pad. Skipping or hand-waving this field produces bad output.
2. \`profileUpdates\` — any fields you can confidently set from the transcript. Include values even if they're already in the current state (re-assertion is harmless). Omit fields you genuinely cannot determine.
3. \`decision\` — exactly one of:
   - \`"ready"\` — every required field below is captured. Produce a warm handoff in \`speech\`.
   - \`"clarify"\` — the guest's most recent answer is ambiguous, incomplete, or you couldn't parse it. Ask a short, specific clarifying question in \`speech\`.
   - \`"ask_next"\` — profile is incomplete but the last answer was fine; ask about the next missing field in \`speech\`.
4. \`speech\` — the exact words Ava will say aloud. 1-2 sentences. No preambles.

### Required fields (priority order)

1. **startDate + endDate** — ISO dates YYYY-MM-DD. Today is ${today}. Assume current year unless the guest said otherwise.
2. **partySize** — total guest count
3. **guestComposition** — \`{ adults, children, childrenAges? }\`
4. **childrenAges** — required only when \`children > 0\`. Must have exactly \`children\` ages.
5. **travelPurpose** — e.g. "leisure", "business", "family vacation", "honeymoon", "celebration", "romantic getaway"
6. **roomAllocation** — only when partySize > 1. Array of guest counts per room, e.g. [4, 2]. Must sum to partySize.

### Parsing rules

- Dates: "between the 10th and the 15th of May" → \`startDate: "${today.slice(0, 4)}-05-10", endDate: "${today.slice(0, 4)}-05-15"\`. Accept any clear range.
- Vague dates: "mid-June", "sometime in spring", "next week" → do NOT guess. Set \`decision: "clarify"\`.
- Party: "2 adults and 4 children" → \`partySize: 6, guestComposition: { adults: 2, children: 4 }\`. "8 guests" alone → \`partySize: 8\` only; leave guestComposition for a follow-up.
- Ages: "2, 4, 6, and 8" or "2, 4, 6, 8" for 4 children → \`childrenAges: [2, 4, 6, 8]\`. When the latest guest turn is bare numbers AND a previous avatar turn asked about ages, treat them as ages.
- Age mismatch: if guest gave fewer/more ages than children count, or a range like "between 12 and 16" for 4 kids → \`decision: "clarify"\`. Do NOT silently accept.
- Room distribution: "all in one room" → \`roomAllocation: [partySize]\`. "separate rooms" → \`[1,1,...]\` (partySize ones). "two rooms, four and two" → \`[4, 2]\`. "evenly" with partySize 8 across 2 rooms → \`[4, 4]\`.

### Decision rules

- If \`profileUpdates\` together with the existing state covers ALL required fields AND you're not clarifying anything → \`"ready"\`.
- If the guest's latest answer was ambiguous, contradicts earlier answers, or you could not extract it → \`"clarify"\`. Name what you didn't catch.
- Otherwise → \`"ask_next"\`. Pick the highest-priority missing field and ask about ONLY that one (or combine dates + guests into one natural question when both are missing at the start).
- Never re-ask a field already captured in the transcript or in \`profileUpdates\`. If it's been answered, move on.

### Clarification style (when decision = "clarify")

- Say briefly that you didn't catch it, then ask specifically. Do NOT pretend you understood.
- Examples:
  - "I didn't quite catch the dates — could you give me specific days in June?"
  - "I caught two ages but there are four children — could you share all four?"
  - "Could you tell me each child's age individually, rather than a range?"
  - "Sorry, I missed that — how many guests will be traveling?"

### Worked examples of the LLM getting it wrong (DO NOT DO THESE)

Guest just said "Between 12 and 16" when there are 4 children:
- WRONG: \`{ profileUpdates: { guestComposition: { adults: 4, children: 4, childrenAges: [12, 13, 14, 15] } }, decision: "ready", speech: "Great, I've noted the children's ages. Let me take you to the hotel!" }\`
- RIGHT: \`{ profileUpdates: {}, decision: "clarify", speech: "Could you tell me each child's age individually rather than a range?" }\`

Profile only has partySize + guestComposition; dates, travel purpose, room allocation are all missing:
- WRONG: \`{ decision: "ready", speech: "Lovely, let's head over." }\`
- RIGHT: \`{ decision: "ask_next", speech: "When are you thinking of traveling?" }\`

Guest said "mid-June":
- WRONG: \`{ profileUpdates: { startDate: "2026-06-15", endDate: "2026-06-20" }, decision: "ask_next", ... }\` (inventing a specific range)
- RIGHT: \`{ profileUpdates: {}, decision: "clarify", speech: "Could you give me specific arrival and departure days in June?" }\`

Guest said "8 guests" and "4 are children":
- WRONG: decision "ready" (travelPurpose, dates, roomAllocation still missing)
- RIGHT: \`{ profileUpdates: { partySize: 8, guestComposition: { adults: 4, children: 4 } }, decision: "ask_next", speech: "When are you thinking of traveling?" }\` (or ask for ages first, both acceptable)

### Ask-next style (when decision = "ask_next")

- Start directly with the question. Never preface with acknowledgment phrases like "Got it", "Great", "Perfect", "Wonderful", "Lovely", "Noted", "Thank you for sharing", "Excellent", "Amazing", "Awesome".
- Ask ONE thing per turn. The only exception is asking for dates + guests at the very start when both are missing.
- 1-2 sentences. Spoken aloud, not typed.

### Ready-handoff style (when decision = "ready")

- Produce a warm 1-2 sentence handoff that restates 2-4 captured details. This is the ONE place warmth is allowed.
- Examples:
  - "Lovely — May 10 to 15, four adults and four children, split two and two. Let me take you to the hotel."
  - "May 10 to 15, the four of you for a family trip. Let's head over."

### Do not

- Do not ask for firstName, lastName, email, phone, or date of birth — those are already known from login.
- Do not invent hotel facts, room names, prices, or amenities.
- Do not produce \`decision: "ready"\` unless every required field is satisfied.

### Current profile state (may be partial/stale — trust the transcript first)
${collectedSummary}`
  }

  // Phase 3: surface the client-side regex-classifier hint for non-PROFILE_COLLECTION
  // stages. The LLM is free to override but should prefer the hint on clear matches.
  // PROFILE_COLLECTION uses the profile_turn tool which has no navigation enum, so
  // the hint is meaningless there — skip it.
  let regexHintBlock = ""
  if (!isProfileCollection && body.regexHint && body.regexHint !== "UNKNOWN") {
    regexHintBlock = `\n\nRegex classifier hint (use as a tiebreaker; override only if the conversation makes it clear the hint is wrong): ${body.regexHint}`
  }

  // Phase 4: universal transcript-aware reconstruction block.
  //
  // For PROFILE_COLLECTION, the `profileCollectionBlock` above already embeds
  // the transcript and the profile state inside its persona/rules pack, so we
  // skip this block there to avoid duplication.
  //
  // For ALL OTHER stages (DESTINATION_SELECT, VIRTUAL_LOUNGE, HOTEL_EXPLORATION,
  // ROOM_SELECTED, ROOM_BOOKING, ...), this is the first time the transcript is
  // made available to the LLM. Without it, the server was trusting whatever
  // client state happened to land in `body.partySize / guestComposition / ...`
  // — which is routinely stale mid-session. With the transcript + reconstructed
  // profile view, the LLM can override stale body fields when the conversation
  // clearly disagrees (e.g., guest said "we're 6 not 8" mid-exploration).
  //
  // Known gap flagged for Phase 9: the `navigate_and_speak` / `adjust_room_plan`
  // / `no_action_speak` tools do NOT accept profileUpdates. So if the LLM
  // detects a party-size correction in the transcript here, it cannot persist
  // it server-side this turn — it can only use the corrected value to shape
  // its reply. Actual profile writes still come through profile_turn (which
  // only fires in PROFILE_COLLECTION) or client-side extract-profile spam
  // (which Phase 9 will delete, replacing with a universal profileUpdates
  // slot on the envelope).
  let transcriptReconstructionBlock = ""
  if (!isProfileCollection && body.conversationHistory?.length) {
    const lines = body.conversationHistory.map((m) => {
      const speaker = m.role === "avatar" ? "Avatar" : "Guest"
      return `${speaker}: ${m.text}`
    })
    const transcript = lines.join("\n")
    const reconstructedSummary = renderReconstructedProfile(reconstructed)
    transcriptReconstructionBlock = `

## Transcript so far (source of truth)
${transcript}

## Reconstructed profile (merged from client state — may be stale)

${reconstructedSummary}

### Transcript-over-body rule

The transcript above is ground truth. The "Reconstructed profile" block is assembled from the client's local state which is frequently stale (React context lags debounced extraction). When the transcript and the reconstructed profile disagree — e.g., the guest said "we're 8 people" but Party size reads "1", or the guest corrected themselves mid-journey ("actually we're 6 not 8") — TRUST THE TRANSCRIPT. Let your speech and any navigation intent reflect the transcript-derived truth, not the stale field.

This is advisory only; do not emit hallucinated navigation to "fix" profile data — the current tools (navigate_and_speak / adjust_room_plan / no_action_speak) don't persist profile updates. Just make sure your speech references the correct numbers and your intent classification doesn't act on a stale prior.`
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
- Use **no_action_speak** when the message doesn't map to any navigation or room plan action — just generate a helpful spoken response.${regexHintBlock}${roomBlock}${guestBlock}${transcriptReconstructionBlock}${profileCollectionBlock}`
}

// ---------------------------------------------------------------------------
// Preamble stripper — gpt-4o-mini doesn't reliably follow the no-preamble rule
// during PROFILE_COLLECTION even when the rule is hoisted with examples.
// A deterministic post-process guarantees the avatar never opens with
// "Thank you for sharing...", "That's wonderful...", etc.
// ---------------------------------------------------------------------------

// Matches a preamble clause at the start of the string, up to and including
// the first sentence terminator (., !, ?) and trailing whitespace. We match
// greedily on common opener phrases then let the rest of the speech pass
// through unchanged. Returns the original string if nothing matches OR if
// stripping would leave an empty result (edge case: the whole speech WAS the
// preamble — better to keep it than go silent).
function stripPreamble(speech: string): string {
  // Four arms:
  //   1. "Thank you ..." — consume up to and including the first terminator
  //   2. "That's wonderful ..." — same pattern
  //   3. Standalone openers like "Noted.", "Perfect!", "Got it." — match opener
  //      followed directly by a terminator (. or !). The old regex used
  //      `[\s,!.][^.!?]*[.!?]?` which over-consumed past the opener into the
  //      next sentence when there was no mid-sentence terminator.
  //   4. Opener followed by comma + clause + terminator, e.g.
  //      "Great, I've noted the ages. Let me..." — up to the first terminator.
  const preambleRe =
    /^\s*(?:thank\s+you[^.!?]*[.!?]|that(?:'s|\s+is|\s+sounds)\s+(?:wonderful|great|lovely|amazing|awesome|fantastic|perfect|excellent)[^.!?]*[.!?]|(?:got\s+it|noted|understood|perfect|great|wonderful|lovely|excellent|amazing|awesome|fantastic|absolutely|certainly|of\s+course|sure\s+thing|sounds\s+(?:good|great|lovely|wonderful))\s*[.!]|(?:got\s+it|noted|understood|perfect|great|wonderful|lovely|excellent|amazing|awesome|fantastic|absolutely|certainly)\s*,[^.!?]*[.!?])\s*/i
  const stripped = speech.replace(preambleRe, "").trim()
  return stripped.length > 0 ? stripped : speech
}

// ---------------------------------------------------------------------------
// profile_turn server-side validator
//
// gpt-4o-mini doesn't reliably follow the multi-constraint rules in the
// PROFILE_COLLECTION prompt (hallucinates ages, declares ready prematurely,
// etc). This validator is the hard gate. It:
//   1. Rejects childrenAges whose length doesn't match children count.
//   2. Rejects decision=ready when any required field is still missing.
// On rejection it overrides decision + speech with a deterministic canned
// response tied to the specific missing/mismatched field.
// ---------------------------------------------------------------------------

type ProfileUpdatesT = {
  startDate?: string
  endDate?: string
  partySize?: number
  guestComposition?: { adults: number; children: number; childrenAges?: number[] }
  travelPurpose?: string
  roomAllocation?: number[]
}

type ProfileTurnT = {
  reasoning?: string
  profileUpdates?: ProfileUpdatesT
  decision: "ask_next" | "clarify" | "ready"
  speech: string
}

type MergedProfileState = {
  startDate?: string
  endDate?: string
  partySize?: number
  guestComposition?: { adults: number; children: number; childrenAges?: number[] }
  travelPurpose?: string
  roomAllocation?: number[]
}

type MissingField =
  | "dates"
  | "guests"
  | "guest_breakdown"
  | "children_ages"
  | "travel_purpose"
  | "room_distribution"

function firstMissingField(s: MergedProfileState): MissingField | null {
  if (!s.startDate || !s.endDate) return "dates"
  if (!s.partySize) return "guests"
  if (!s.guestComposition) return "guest_breakdown"
  if (s.guestComposition.children > 0) {
    const ages = s.guestComposition.childrenAges
    if (!ages || ages.length !== s.guestComposition.children) return "children_ages"
  }
  if (!s.travelPurpose) return "travel_purpose"
  if (s.partySize > 1) {
    const alloc = s.roomAllocation
    if (!alloc || alloc.length === 0) return "room_distribution"
    const sum = alloc.reduce((a, b) => a + b, 0)
    if (sum !== s.partySize) return "room_distribution"
  }
  return null
}

const CANNED_SPEECH: Record<MissingField, string> = {
  dates: "When are you thinking of traveling?",
  guests: "How many will be joining you?",
  guest_breakdown: "Will it be all adults, or are there any little ones in your group?",
  children_ages: "And how old are the little ones?",
  travel_purpose: "What brings you to the area?",
  room_distribution: "How would you like to split the guests across rooms?",
}

function validateProfileTurn(
  result: ProfileTurnT,
  body: RequestBody,
): { result: ProfileTurnT; overridden: "ages_mismatch" | "ready_premature" | null } {
  console.log("[VALIDATOR] entered", JSON.stringify({
    llmDecision: result.decision,
    llmProfileUpdates: result.profileUpdates,
    bodyState: {
      startDate: body.startDate,
      endDate: body.endDate,
      partySize: body.partySize,
      guestComposition: body.guestComposition,
      travelPurpose: body.travelPurpose,
      roomAllocation: body.roomAllocation,
    },
  }))
  const updates: ProfileUpdatesT = { ...(result.profileUpdates ?? {}) }

  // --- Check 1: ages length must match children count ---
  // We validate against the merged composition so we catch cases where the
  // LLM provides only childrenAges on this turn while children came from
  // earlier state.
  const mergedComp = updates.guestComposition ?? body.guestComposition
  if (mergedComp && updates.guestComposition?.childrenAges) {
    const ages = updates.guestComposition.childrenAges
    const n = mergedComp.children
    if (n > 0 && ages.length !== n) {
      // Drop the bad field so we don't write hallucinated ages to state.
      updates.guestComposition = {
        ...updates.guestComposition,
        childrenAges: undefined,
      }
      const countWord = ages.length === 0 ? "none" : `only ${ages.length}`
      const speech =
        ages.length < n
          ? `I caught ${countWord} of the ${n} ages — could you share all ${n}?`
          : `I caught ${ages.length} ages but there are ${n} children — could you tell me each child's age?`
      return {
        result: {
          profileUpdates: updates,
          decision: "clarify",
          speech,
        },
        overridden: "ages_mismatch",
      }
    }
  }

  // --- Check 2: if decision is "ready", every required field must be set ---
  if (result.decision === "ready") {
    // Deep-merge guestComposition so a partial update like
    // { childrenAges: [2, 4] } doesn't wipe adults/children from the body.
    // Same bug class we already fixed client-side in lib/context.tsx —
    // the shallow `??` kept reappearing elsewhere because nested objects
    // need explicit merging.
    const mergedGuestComposition = updates.guestComposition
      ? ({
          ...(body.guestComposition ?? {}),
          ...updates.guestComposition,
        } as MergedProfileState["guestComposition"])
      : body.guestComposition

    // Derive partySize from the MERGED composition (not raw updates), so
    // adults/children inherited from body still contribute to the total.
    const derivedFromComp =
      mergedGuestComposition &&
      typeof mergedGuestComposition.adults === "number" &&
      typeof mergedGuestComposition.children === "number"
        ? mergedGuestComposition.adults + mergedGuestComposition.children
        : undefined
    const partySize = updates.partySize ?? derivedFromComp ?? body.partySize

    const merged: MergedProfileState = {
      startDate: updates.startDate ?? body.startDate,
      endDate: updates.endDate ?? body.endDate,
      partySize,
      guestComposition: mergedGuestComposition,
      travelPurpose: updates.travelPurpose ?? body.travelPurpose,
      roomAllocation: updates.roomAllocation ?? body.roomAllocation,
    }

    const missing = firstMissingField(merged)
    console.log("[VALIDATOR] ready check", JSON.stringify({ merged, missing }))
    if (missing !== null) {
      return {
        result: {
          profileUpdates: updates,
          decision: "ask_next",
          speech: CANNED_SPEECH[missing],
        },
        overridden: "ready_premature",
      }
    }
  }

  // No override needed.
  return {
    result: { ...result, profileUpdates: updates },
    overridden: null,
  }
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

const PROFILE_TURN_TOOL: OpenAITool = {
  type: "function" as const,
  function: {
    name: "profile_turn",
    description:
      "Single source of truth for a PROFILE_COLLECTION turn. Extract fields from the transcript, decide what to do next, and produce speech.",
    parameters: {
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          description:
            "Brief internal monologue (2-5 sentences). What did the guest just say? What does the current state show? What's missing? Why is your decision/speech correct? Write this FIRST, before any other field. This is not spoken aloud.",
        },
        profileUpdates: {
          type: "object",
          description: "Fields you can confidently set from the transcript. Omit any field you can't determine.",
          properties: {
            startDate: { type: "string", description: "Travel start date, YYYY-MM-DD" },
            endDate: { type: "string", description: "Travel end date, YYYY-MM-DD" },
            partySize: { type: "number", description: "Total guest count" },
            guestComposition: {
              type: "object",
              description: "Partial updates allowed. Send only the fields you're changing this turn (e.g., just childrenAges when ages come in after adults/children were already captured). Server merges with prior state.",
              properties: {
                adults: { type: "number" },
                children: { type: "number" },
                childrenAges: {
                  type: "array",
                  items: { type: "number" },
                  description: "One age per child; length must match children count in merged state",
                },
              },
            },
            travelPurpose: { type: "string" },
            roomAllocation: {
              type: "array",
              items: { type: "number" },
              description: "Guest counts per room; must sum to partySize",
            },
          },
        },
        decision: {
          type: "string",
          enum: ["ask_next", "clarify", "ready"],
          description:
            "ask_next = ask next missing field; clarify = latest answer was ambiguous; ready = all required fields captured",
        },
        speech: {
          type: "string",
          description: "Exact words Ava will say. 1-2 sentences. No preamble unless decision=ready.",
        },
      },
      required: ["reasoning", "decision", "speech"],
    },
  },
}

function buildTools(
  hasRooms: boolean,
  includeAdjustRoomPlan = true,
  adjustRoomPlanActions?: string[],
) {
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

  if (includeAdjustRoomPlan) {
    const actions = adjustRoomPlanActions ?? [
      "adjust_budget",
      "set_room_composition",
      "compact_plan",
      "set_distribution",
      "recompute_with_preferences",
      "no_room_change",
    ]
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
              enum: actions,
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
// TurnDecision builder (Phase 1 envelope)
//
// Normalizes whichever tool fired into a single shape the client can
// shadow-compare against its legacy dispatch path. Kept server-side so the
// wire format is owned by the route and clients don't have to re-derive it.
// ---------------------------------------------------------------------------

type TurnDecisionProposalKind =
  | "rooms"
  | "amenity"
  | "location"
  | "interior"
  | "exterior"
  | "hotel"
  | "other"

type TurnDecisionActionWire =
  | { type: "USER_INTENT"; intent: string; amenityName?: string; params?: Record<string, unknown> }
  | { type: "ROOM_PLAN_ACTION"; action: string; updates: Record<string, unknown> }
  | {
      type: "PROFILE_TURN_RESULT"
      decision: "ask_next" | "clarify" | "ready"
      awaiting?: string
      profileUpdates?: Record<string, unknown>
    }
  | { type: "NO_ACTION" }
  | null

type TurnDecisionWire = {
  action: TurnDecisionActionWire
  speech: string
  reasoning?: string
  proposal?: { kind: TurnDecisionProposalKind; targetId?: string; label?: string }
}

function proposalForIntent(
  intent: string,
  amenityName?: string,
): { kind: TurnDecisionProposalKind; targetId?: string; label?: string } | undefined {
  switch (intent) {
    case "ROOMS":
      return { kind: "rooms" }
    case "AMENITIES":
      return { kind: "amenity" } // generic amenity listing
    case "AMENITY_BY_NAME":
      return amenityName
        ? { kind: "amenity", targetId: amenityName, label: amenityName }
        : { kind: "amenity" }
    case "LOCATION":
      return { kind: "location" }
    case "INTERIOR":
      return { kind: "interior" }
    case "EXTERIOR":
      return { kind: "exterior" }
    case "HOTEL_EXPLORE":
      return { kind: "hotel" }
    default:
      return undefined
  }
}

function buildTurnDecision(args: {
  functionName: string
  result: Record<string, unknown>
  speech: string
  validatorOverride: "ages_mismatch" | "ready_premature" | null
}): TurnDecisionWire {
  const { functionName, result, speech, validatorOverride } = args
  const reasoning = typeof result.reasoning === "string" ? result.reasoning : undefined
  const reasoningAnnotated = validatorOverride
    ? `${reasoning ? `${reasoning} | ` : ""}validator_override=${validatorOverride}`
    : reasoning

  if (functionName === "navigate_and_speak") {
    const intent = typeof result.intent === "string" ? result.intent : "UNKNOWN"
    const amenityName =
      typeof result.amenityName === "string" ? result.amenityName : undefined
    const params: Record<string, unknown> | undefined =
      amenityName ? { amenityName } : undefined
    const proposal = proposalForIntent(intent, amenityName)
    const action: TurnDecisionActionWire = {
      type: "USER_INTENT",
      intent,
      ...(amenityName ? { amenityName } : {}),
      ...(params ? { params } : {}),
    }
    return {
      action,
      speech,
      ...(reasoningAnnotated ? { reasoning: reasoningAnnotated } : {}),
      ...(proposal ? { proposal } : {}),
    }
  }

  if (functionName === "adjust_room_plan") {
    const action = typeof result.action === "string" ? result.action : "no_room_change"
    // Capture every flat param the tool schema allows — the client can pick
    // whichever it cares about. Undefined fields are omitted so the envelope
    // stays compact.
    const rawUpdates: Record<string, unknown> = {
      target_per_night: result.target_per_night,
      rooms: result.rooms,
      max_rooms: result.max_rooms,
      allocation: result.allocation,
      budget_range: result.budget_range,
      distribution_preference: result.distribution_preference,
      room_type_preference: result.room_type_preference,
    }
    const updates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rawUpdates)) {
      if (v !== undefined) updates[k] = v
    }
    return {
      action: { type: "ROOM_PLAN_ACTION", action, updates },
      speech,
      ...(reasoningAnnotated ? { reasoning: reasoningAnnotated } : {}),
    }
  }

  if (functionName === "profile_turn") {
    const decisionVal = result.decision
    const decision: "ask_next" | "clarify" | "ready" =
      decisionVal === "ask_next" || decisionVal === "clarify" || decisionVal === "ready"
        ? decisionVal
        : "ask_next"
    const profileUpdates =
      result.profileUpdates && typeof result.profileUpdates === "object"
        ? (result.profileUpdates as Record<string, unknown>)
        : undefined
    return {
      action: {
        type: "PROFILE_TURN_RESULT",
        decision,
        ...(profileUpdates && Object.keys(profileUpdates).length > 0
          ? { profileUpdates }
          : {}),
      },
      speech,
      ...(reasoningAnnotated ? { reasoning: reasoningAnnotated } : {}),
    }
  }

  // no_action_speak, or anything else (validator override / fallback) —
  // represent as NO_ACTION with reasoning annotated so the client can see why.
  return {
    action: { type: "NO_ACTION" },
    speech,
    ...(reasoningAnnotated ? { reasoning: reasoningAnnotated } : {}),
  }
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

  const requestStart = Date.now()
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
    // Phase 4: reconstruct profile from client body + transcript before
    // building the prompt. Logged at the bottom of the handler so we can
    // diagnose when transcript disagrees with client body.
    const reconstructedProfile = reconstructProfileFromTranscript(
      body.conversationHistory,
      body,
    )
    const systemPrompt = buildSystemPrompt(body, reconstructedProfile)
    // PROFILE_COLLECTION uses a single profile_turn tool that owns extraction,
    // decision, and speech — no navigate/room-plan tools are offered here.
    // Other stages keep the legacy tools.
    const tools = isProfileCollection
      ? [PROFILE_TURN_TOOL]
      : buildTools(hasRooms, hasRooms, undefined)
    const toolChoice = isProfileCollection
      ? ({ type: "function" as const, function: { name: "profile_turn" } })
      : "auto"

    // Build journey context block for user message
    const jc = body.journeyContext
    let journeyBlock = `\n\nJourney context:\n- Stage: ${jc.stage}`
    if (jc.subState) journeyBlock += `\n- Sub-state: ${jc.subState}`
    if (jc.lastProposal) journeyBlock += `\n- Last avatar proposal: ${jc.lastProposal}`
    if (jc.suggestedAmenityName) journeyBlock += `\n- Suggested amenity: ${jc.suggestedAmenityName}`
    if (jc.suggestedNext) journeyBlock += `\n- Suggested next amenity: ${jc.suggestedNext}`

    const controller = new AbortController()
    // 15s: gpt-4o with a growing conversation transcript (up to 80 messages)
    // and a reconstructed-profile block occasionally exceeds 7s. 503s there
    // manifest as silent avatar hangs on the client, so prefer slow-but-land
    // over fail-fast.
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // PROFILE_COLLECTION is multi-constraint extraction (dates, party,
          // ages, purpose, allocation) with hard rules the validator enforces.
          // gpt-4o-mini routinely returns empty profileUpdates + decision:
          // "ready", looping the same ask. gpt-4o handles it reliably.
          model: isProfileCollection ? "gpt-4o" : "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `User message: "${body.message}"${journeyBlock}` },
          ],
          temperature: 0.3,
          tools,
          tool_choice: toolChoice,
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
      let result = validated.data as Record<string, unknown>
      let validatorOverride: "ages_mismatch" | "ready_premature" | null = null

      // Server-side gate for profile_turn — see validateProfileTurn. Runs
      // BEFORE strip / response construction so any override flows through
      // the normal speech pipeline.
      if (functionName === "profile_turn") {
        const check = validateProfileTurn(result as unknown as ProfileTurnT, body)
        result = check.result as unknown as Record<string, unknown>
        validatorOverride = check.overridden
      }

      const responseBody: Record<string, unknown> = { tool: functionName }

      // Belt-and-suspenders: gpt-4o-mini ignores the no-preamble rule in the
      // system prompt often enough that a deterministic strip is needed.
      // Applied during PROFILE_COLLECTION, and skipped only for warm handoffs
      // (profile_turn with decision=ready, or legacy TRAVEL_TO_HOTEL). After
      // the validator, decision=ready only survives when it's actually valid.
      const isReadyHandoff =
        (functionName === "profile_turn" && result.decision === "ready") ||
        (functionName === "navigate_and_speak" && result.intent === "TRAVEL_TO_HOTEL")
      const shouldStripPreamble = isProfileCollection && !isReadyHandoff
      const cleanSpeech = (s: unknown) =>
        shouldStripPreamble && typeof s === "string" ? stripPreamble(s) : s

      if (functionName === "navigate_and_speak") {
        responseBody.intent = result.intent
        if (result.amenityName) responseBody.amenityName = result.amenityName
        responseBody.speech = cleanSpeech(result.speech)
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
        responseBody.speech = cleanSpeech(result.speech)
      } else if (functionName === "profile_turn") {
        responseBody.reasoning = result.reasoning
        responseBody.profileUpdates = result.profileUpdates ?? {}
        responseBody.decision = result.decision
        responseBody.speech = cleanSpeech(result.speech)
      } else {
        // no_action_speak
        responseBody.speech = cleanSpeech(result.speech)
      }

      // --- Phase 1: TurnDecision envelope -------------------------------
      // Normalize whichever tool fired into a single shape the client can
      // shadow-compare against its legacy dispatch path. Purely additive;
      // legacy fields above remain untouched.
      const outSpeechForDecision =
        typeof responseBody.speech === "string" ? responseBody.speech : ""
      const finalSpeechText = outSpeechForDecision

      const decision = buildTurnDecision({
        functionName,
        result,
        speech: finalSpeechText,
        validatorOverride,
      })
      // NOTE: legacy profile_turn responses already use `decision` for the
      // enum string ("ask_next" | "clarify" | "ready"). We emit the Phase 1
      // envelope under a separate key to avoid clobbering that field.
      responseBody.decision_envelope = decision

      console.log("[ORCHESTRATE]", JSON.stringify({
        stage: body.journeyContext.stage,
        awaiting: body.profileAwaiting,
        tool: functionName,
        toolCalled: functionName,
        latencyMs: Date.now() - requestStart,
        reasoning: result.reasoning,
        decision: result.decision,
        profileUpdates: result.profileUpdates,
        validatorOverride,
        rawSpeech: result.speech,
        stripped: shouldStripPreamble,
        outSpeech: responseBody.speech,
        decisionAction: (decision as { action?: { type?: string } | null })?.action?.type ?? null,
        // Phase 4: the reconciled profile view the prompt reasoned against.
        // Omit raw transcript from the log to avoid noise — only the merged
        // struct. Diagnoses cases where client body is stale vs. transcript.
        reconstructedProfile,
        historyLen: body.conversationHistory?.length ?? 0,
      }))

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
