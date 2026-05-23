import { z } from "zod"
import { SALES_PERSONA, buildGuestIntelligenceBlock } from "@/lib/avatar-context-builder"
import type { UserDBProfile } from "@/lib/auth-context"
import type {
  HotelCatalogAddress,
  PackedAmenity,
} from "@/lib/hotel-data"
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
  "LIGHTING_CHANGE",
  "LIGHTING_SET",
  "LOCATE_INTEREST_POINTS",
  "UNKNOWN",
] as const

const LIGHTING_MODE_VALUES = ["daylight", "sunset", "night"] as const

// ---------------------------------------------------------------------------
// Zod schemas for tool argument validation
// ---------------------------------------------------------------------------

// ProfileUpdatesSchema — shared by profile_turn (PROFILE_COLLECTION) and the
// three non-profile tools (mid-conversation corrections at all other stages).
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

const NavigateAndSpeakSchema = z.object({
  intent: z.enum(INTENT_VALUES),
  amenityName: z.string().optional(),
  lightingMode: z.enum(LIGHTING_MODE_VALUES).optional(),
  // Free-text Places-API query used when intent is LOCATE_INTEREST_POINTS
  // (e.g. "kitesurfing", "romantic restaurants in Bellagio"). Capped to keep
  // pathological inputs out of the downstream Places call.
  category: z.string().min(1).max(120).optional(),
  speech: z.string().min(1).max(500),
  profileUpdates: ProfileUpdatesSchema.optional(),
})

const NoActionSpeakSchema = z.object({
  speech: z.string().min(1).max(500),
  profileUpdates: ProfileUpdatesSchema.optional(),
})

const ProfileTurnSchema = z.object({
  // Optional diagnostic only. Keeping it optional lets the profile path emit
  // fewer tokens before the speech field, which improves time-to-first-audio.
  reasoning: z.string().min(1).max(1000).optional(),
  profileUpdates: ProfileUpdatesSchema.optional().default({}),
  decision: z.enum(["ask_next", "clarify", "ready"]),
  speech: z.string().min(1).max(500),
})

// ---------------------------------------------------------------------------
// Experiment: action-dispatch tools (AMENITY_VIEWING `book` surface only).
// Gated by RequestBody.experiment === "action-dispatch". When active, the
// model picks ONE of these three instead of navigate_and_speak/no_action_speak.
// Each tool's `text` is the spoken response Ava will say. See plan
// `inherited-beaming-gray.md` and useJourney.ts gate logic.
// ---------------------------------------------------------------------------
const NavigateToAmenityActionSchema = z.object({
  amenityId: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
})
const OpenRoomsPanelActionSchema = z.object({
  text: z.string().min(1).max(500),
})
const SpeakOnlyActionSchema = z.object({
  text: z.string().min(1).max(500),
})

// ---------------------------------------------------------------------------
// Full action-dispatch migration — additional action tools beyond the 3 primary
// ones above. Each is a thin wrapper that maps to an existing reducer dispatch
// path client-side (see plan `vast-rolling-adleman.md`).
//
// History: this list started as 14 "padding tools" used purely for schema-cost
// measurement during Phase 1a. With the `?fullActionDispatch=1` migration they
// became real implementations; the PADDING_ prefix is kept on the
// schema/description/parameter maps to minimize cross-file churn (orchestrateLLM
// still imports PADDING_TOOL_RESULT_NAMES). Two tools dropped vs. Phase 1a:
//   • `confirm_return_to_lounge` — RETURN_TO_LOUNGE intent already escalates
//     to LOUNGE_CONFIRMING in the reducer; LLM never needs to "ask to confirm"
//     explicitly. Replaced by the dedicated affirm/cancel pair below.
//   • `end_experience` — same logic: END_EXPERIENCE escalates to END_CONFIRMING.
//     Replaced by `end_experience_affirm` / `end_experience_cancel`.
// Five tools added: `end_experience_affirm`, `end_experience_cancel`,
// `lounge_return_affirm`, `lounge_return_cancel`, `explore_lounge_action`.
// ---------------------------------------------------------------------------
const TextOnlyPaddingSchema = z.object({
  text: z.string().min(1).max(500),
})
const ChangeLightingPaddingSchema = z.object({
  mode: z.enum(["daylight", "sunset", "night"]),
  text: z.string().min(1).max(500),
})
const LocateInterestPointsPaddingSchema = z.object({
  category: z.string().min(1).max(120),
  text: z.string().min(1).max(500),
})
const SelectHotelPaddingSchema = z.object({
  hotelSlug: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
})

// Full action-dispatch tool names (everything except the 3 primary tools
// declared above). Drives the schema map, prompt block, and client parser
// from a single source. See header comment for the deltas vs. Phase 1a.
const PADDING_TOOL_NAMES = [
  "travel_to_hotel",
  "return_to_virtual_lounge",
  "show_hotel_overview",
  "list_amenities",
  "step_into_unit",
  "step_out_of_unit",
  "back_to_rooms_panel",
  "open_booking_url",
  "change_lighting",
  "locate_interest_points",
  "open_map",
  "confirm_end_experience",
  "end_experience_affirm",
  "end_experience_cancel",
  "lounge_return_affirm",
  "lounge_return_cancel",
  "explore_lounge_action",
  "select_hotel",
  "download_user_data",
] as const
type PaddingToolName = typeof PADDING_TOOL_NAMES[number]

const PADDING_TOOL_SCHEMAS: Record<PaddingToolName, z.ZodTypeAny> = {
  travel_to_hotel: TextOnlyPaddingSchema,
  return_to_virtual_lounge: TextOnlyPaddingSchema,
  show_hotel_overview: TextOnlyPaddingSchema,
  list_amenities: TextOnlyPaddingSchema,
  step_into_unit: TextOnlyPaddingSchema,
  step_out_of_unit: TextOnlyPaddingSchema,
  back_to_rooms_panel: TextOnlyPaddingSchema,
  open_booking_url: TextOnlyPaddingSchema,
  change_lighting: ChangeLightingPaddingSchema,
  locate_interest_points: LocateInterestPointsPaddingSchema,
  open_map: TextOnlyPaddingSchema,
  confirm_end_experience: TextOnlyPaddingSchema,
  end_experience_affirm: TextOnlyPaddingSchema,
  end_experience_cancel: TextOnlyPaddingSchema,
  lounge_return_affirm: TextOnlyPaddingSchema,
  lounge_return_cancel: TextOnlyPaddingSchema,
  explore_lounge_action: TextOnlyPaddingSchema,
  select_hotel: SelectHotelPaddingSchema,
  download_user_data: TextOnlyPaddingSchema,
}

const TOOL_SCHEMAS: Record<string, z.ZodTypeAny> = {
  navigate_and_speak: NavigateAndSpeakSchema,
  no_action_speak: NoActionSpeakSchema,
  profile_turn: ProfileTurnSchema,
  navigate_to_amenity_action: NavigateToAmenityActionSchema,
  open_rooms_panel_action: OpenRoomsPanelActionSchema,
  speak_only_action: SpeakOnlyActionSchema,
  ...PADDING_TOOL_SCHEMAS,
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

interface SelectedRoomInfo extends RoomInfo {
  area?: { min_sqm: number; max_sqm: number; label: string }
  roomType?: string
  features?: string[]
  view?: string[]
  bedding?: string[]
  bath?: string[]
  tech?: string[]
  services?: string[]
}

interface JourneyContext {
  stage: string
  subState?: string
  lastProposal?: string
  suggestedAmenityName?: string
  suggestedNext?: string
  /**
   * The amenity the guest is currently inside (AMENITY_VIEWING only).
   * Today the existing prompt block at the AMENITY_VIEWING branch reuses
   * `suggestedAmenityName` as a hack — but for AMENITY_VIEWING that field is
   * actually undefined (the JourneyState.AMENITY_VIEWING variant carries
   * `currentAmenity` + `suggestedNext`, not `suggestedAmenityName`).
   * This dedicated field lets the action-dispatch experiment ground the LLM
   * in the actual currently-viewed amenity.
   */
  currentAmenity?: { id: string; name: string }
  /**
   * Current view mode within ROOM_SELECTED ("interior" | "exterior" |
   * undefined). Used by the action-dispatch ROOM_SELECTED prompt block so
   * the LLM can ground `step_into_unit` / `step_out_of_unit` / `back_to_rooms_panel`
   * decisions in what the guest is currently looking at.
   */
  viewMode?: "interior" | "exterior"
}

interface RequestBody {
  message: string
  journeyContext: JourneyContext
  rooms?: RoomInfo[]
  selectedRoom?: SelectedRoomInfo
  /**
   * Actual amenity names available at the currently selected hotel. Used to
   * ground the prompt so the LLM doesn't freestyle amenities from the
   * AMENITY_BY_NAME intent enum (which lists pool/spa/restaurant/gym/etc as
   * classification categories — not as guarantees that the property has
   * them).
   *
   * NOTE: Active amenities only. Superseded by `hotelAmenitiesActive` for
   * richer grounding; kept for backward compatibility.
   */
  hotelAmenityNames?: string[]
  /**
   * Hotel-level info for the prompt's hotel-overview block. Renders only on
   * non-PROFILE_COLLECTION turns so the LLM can answer property questions
   * ("tell me about this place", "where is it?") with grounded facts.
   */
  hotelInfo?: {
    name: string
    location: string
    tagline?: string
    description?: string
    highlights?: string[]
    address?: HotelCatalogAddress
    tags?: string[]
    websiteUrl?: string
  }
  /**
   * Active amenities — visitable in the live tour. Each carries the rich
   * fields the prompt's amenities-block renders (category, shortDescription,
   * highlights, hours). The full `description` is also included but ONLY
   * rendered for the focused amenity (mirrors the rooms / selectedRoom
   * pattern: condensed list always, full block only on focus).
   */
  hotelAmenitiesActive?: PackedAmenity[]
  /**
   * Amenities that exist at the property but aren't part of the live tour
   * (no UE5 scene). The prompt instructs the LLM to describe them when
   * asked but never to invoke a navigation tool on them.
   */
  hotelAmenitiesDescribedOnly?: PackedAmenity[]
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
  /**
   * UUID v4 minted on the client at "user message lands" so the server can
   * stamp it on its `[ORCHESTRATE]` log line and echo it back in the
   * response. Powers the per-session log file in `logs/` — without it the
   * client and server timing blocks for the same turn can't be correlated.
   */
  turnId?: string
  /**
   * Experiment opt-in. When "action-dispatch", the server swaps the
   * navigate_and_speak / no_action_speak tools for the three experimental
   * action tools (navigate_to_amenity_action / open_rooms_panel_action /
   * speak_only_action) and uses a dedicated AMENITY_VIEWING prompt block.
   * Gated client-side to AMENITY_VIEWING + /\bbook\b/ — see useJourney.ts.
   */
  experiment?: "action-dispatch"
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
// Amenity prompt-block helpers
// ---------------------------------------------------------------------------

/**
 * Render one amenity as a multi-line bullet for the condensed list block.
 * Uses shortDescription + a couple highlights + hours when present. The
 * long `description` field is intentionally skipped here — that's reserved
 * for the focused-amenity block to keep prompt token cost bounded.
 */
function renderAmenityListItem(a: PackedAmenity): string {
  const head = a.category ? `${a.name} (${a.category})` : a.name
  const desc = a.shortDescription ? ` — ${a.shortDescription}` : ""
  const lines: string[] = [`- ${head}${desc}`]
  if (a.highlights && a.highlights.length > 0) {
    const top = a.highlights.slice(0, 2).join("; ")
    lines.push(`  Highlights: ${top}`)
  }
  if (a.hours && a.hours.length > 0) {
    const hoursStr = a.hours
      .map((h) => (h.is24Hours ? `${h.label} 24h ${h.days}` : `${h.label} ${h.open}-${h.close} ${h.days}`))
      .join("; ")
    lines.push(`  Hours: ${hoursStr}`)
  }
  if (a.menuUrl) lines.push(`  Menu link available.`)
  return lines.join("\n")
}

/**
 * Render the full amenity block for the focused-amenity injection — mirrors
 * `selectedRoom` rendering in style. All non-empty fields go in.
 */
function renderAmenityFullDetail(a: PackedAmenity): string {
  const entries: string[] = []
  entries.push(`- name: ${a.name}`)
  entries.push(`- scene: ${a.scene}`)
  if (a.category) entries.push(`- category: ${a.category}`)
  if (a.shortDescription) entries.push(`- shortDescription: ${a.shortDescription}`)
  if (a.description) entries.push(`- description: ${a.description}`)
  if (a.highlights?.length) entries.push(`- highlights: ${JSON.stringify(a.highlights)}`)
  if (a.tags?.length) entries.push(`- tags: ${JSON.stringify(a.tags)}`)
  if (a.features?.length) entries.push(`- features: ${JSON.stringify(a.features)}`)
  if (a.hours?.length) entries.push(`- hours: ${JSON.stringify(a.hours)}`)
  if (a.menuUrl) entries.push(`- menuUrl: ${a.menuUrl}`)
  if (a.externalUrl) entries.push(`- externalUrl: ${a.externalUrl}`)
  return entries.join("\n")
}

/**
 * Detect which amenity (if any) the user's latest message is asking about.
 * Searches both active and described-only lists by name + aliases. Returns
 * the first match together with a flag indicating whether it's navigable.
 *
 * Detection is intentionally simple — substring match against the lowercased
 * message. The LLM still owns intent classification; this is just the trigger
 * to inject the focused amenity's full data block.
 */
function detectFocusedAmenity(
  message: string,
  active: PackedAmenity[] | undefined,
  describedOnly: PackedAmenity[] | undefined,
): { amenity: PackedAmenity; navigable: boolean } | null {
  if (!message) return null
  const text = message.toLowerCase()
  const hit = (a: PackedAmenity): boolean => {
    if (text.includes(a.name.toLowerCase())) return true
    if (a.scene && text.includes(a.scene.toLowerCase())) return true
    if (a.aliases) {
      for (const alias of a.aliases) if (text.includes(alias.toLowerCase())) return true
    }
    return false
  }
  for (const a of active ?? []) if (hit(a)) return { amenity: a, navigable: true }
  for (const a of describedOnly ?? []) if (hit(a)) return { amenity: a, navigable: false }
  return null
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildProfileCollectionPrompt(body: RequestBody): string {
  const today = new Date().toISOString().slice(0, 10)
  const currentYear = today.slice(0, 4)

  const collectedLines: string[] = []
  if (body.startDate && body.endDate) {
    collectedLines.push(`- Dates: ${body.startDate} to ${body.endDate}`)
  } else if (body.startDate) {
    collectedLines.push(`- Start date: ${body.startDate}; end date missing`)
  } else if (body.endDate) {
    collectedLines.push(`- End date: ${body.endDate}; start date missing`)
  }

  const compTotal = body.guestComposition
    ? (body.guestComposition.adults ?? 0) + (body.guestComposition.children ?? 0)
    : 0
  const effectivePartySize = compTotal > 0 ? compTotal : body.partySize
  if (effectivePartySize) {
    collectedLines.push(`- Party size: ${effectivePartySize}`)
  }
  if (body.guestComposition) {
    const ages = body.guestComposition.childrenAges?.length
      ? `; ages ${body.guestComposition.childrenAges.join(", ")}`
      : ""
    collectedLines.push(
      `- Guest composition: ${body.guestComposition.adults} adults, ${body.guestComposition.children} children${ages}`,
    )
  }
  if (body.travelPurpose) collectedLines.push(`- Travel purpose: ${body.travelPurpose}`)
  if (body.roomAllocation?.length) {
    collectedLines.push(`- Room distribution: ${body.roomAllocation.join(" + ")}`)
  }
  if (body.guestFirstName) collectedLines.push(`- Guest name: ${body.guestFirstName}`)

  const collectedSummary = collectedLines.length
    ? collectedLines.join("\n")
    : "- (nothing collected yet)"

  const transcript = (body.conversationHistory ?? [])
    .slice(-24)
    .map((m) => `${m.role === "avatar" ? "Avatar" : "Guest"}: ${m.text}`)
    .join("\n")

  const regexHint =
    body.regexHint && body.regexHint !== "UNKNOWN"
      ? `\n\nRegex skip-ahead hint: ${body.regexHint}`
      : ""

  return `You are Ava, a concise AI hotel concierge. Handle PROFILE_COLLECTION with the smallest correct tool call.

Call exactly one tool:
- profile_turn for normal profile collection.
- navigate_and_speak only if the latest guest message explicitly asks to skip ahead to rooms, amenities, a named amenity, location, the hotel, or booking.

Today is ${today}. Assume year ${currentYear} for clear month/day dates unless the guest states another year.

Required profile fields, in order:
1. startDate + endDate
2. partySize
3. guestComposition { adults, children, childrenAges? }
4. childrenAges only when children > 0, exactly one age per child
5. travelPurpose
6. roomAllocation only when partySize > 1; counts must sum to partySize

Current profile state:
${collectedSummary}

Conversation:
${transcript || "(none)"}

Rules:
- The transcript is the source of truth. Re-extract fields from it, but never invent missing values.
- Vague dates like "mid-June" or "next week" need clarification. Clear ranges like "May 10 to 15" become ${currentYear}-05-10 to ${currentYear}-05-15.
- "8 adults" means partySize 8 and guestComposition { adults: 8, children: 0 }. Always include children: 0 for adults-only groups.
- "8 guests" alone gives partySize only; ask for adults/children next.
- Bare numbers after the avatar asked for children's ages are ages.
- If an age count does not match the child count, decision is clarify.
- Room split examples: "all together" -> [partySize]; "separate rooms" -> [1,1,...]; "two rooms, four and two" -> [4,2].
- Ask one thing per turn. For ask_next, start directly with the question; no "Got it", "Great", "Perfect", "Wonderful", "Lovely", "Noted", or similar preamble.
- If every required field is present, decision is ready and speech should briefly summarize 2-4 details, then ask whether to visit the virtual lounge first or go straight to the hotel.

Use these exact ask_next questions when they match the next missing field:
- Dates missing: "What are your travel dates?"
- Guests missing: "How many guests are traveling?"
- Guest breakdown missing: "How many adults and children are in your group?"
- Children ages missing: "What are the children's ages?"
- Travel purpose missing: "What brings you to the area?"
- Room distribution missing: "How would you like to split your guests across rooms?"

Skip-ahead mapping:
- rooms, suites, accommodation, "book a room", "book it", "I want to book" -> intent ROOMS or BOOK
- amenities/facilities -> AMENITIES
- pool/spa/restaurant/lobby/conference/gym/bar/lounge/dining -> AMENITY_BY_NAME with amenityName
- "book/reserve a {amenity}" (book a conference room, book a restaurant, reserve the spa, book a table) -> AMENITY_BY_NAME with the named amenity, NOT BOOK. The verb "book" only maps to BOOK when the object is the stay itself (a room/suite/it/this).
- surroundings/location/area -> LOCATION
- hotel/property/tour/continue/go ahead -> HOTEL_EXPLORE or TRAVEL_TO_HOTEL
For skip-ahead speech, acknowledge briefly and lead in. Do not ask another profile question.${regexHint}`
}

// ---------------------------------------------------------------------------
// Per-stage action-dispatch prompt blocks. Returns "" for stages outside the
// migrated set. Each block teaches the LLM which subset of tools is legal in
// the current stage and gives worked examples for the tricky cases. See plan
// `vast-rolling-adleman.md` and the source handoff `action-dispatch-full-
// migration-handoff.md` section 5 for the per-stage specs.
// ---------------------------------------------------------------------------
function buildActionDispatchPromptBlock(body: RequestBody): string {
  const stage = body.journeyContext.stage
  if (!MIGRATED_STAGES_FOR_EXPERIMENT.has(stage)) return ""

  const activeAmenitiesList = (body.hotelAmenitiesActive ?? [])
    .map((a) => `  - id="${a.id}", name="${a.name}"`)
    .join("\n") || "  (none)"

  if (stage === "AMENITY_VIEWING") {
    const currentAmenityName =
      body.journeyContext.currentAmenity?.name ?? body.journeyContext.suggestedAmenityName ?? "unknown"
    const currentAmenityId = body.journeyContext.currentAmenity?.id ?? "unknown"
    const suggestedNext = body.journeyContext.suggestedNext

    return `\n\n## AMENITY_VIEWING — action-dispatch (current stage)

The guest is currently inside the amenity space: **${currentAmenityName}** (id="${currentAmenityId}").
${suggestedNext ? `Next unvisited amenity queued: **${suggestedNext}**.` : "No further unvisited amenity queued."}

Active amenities the guest can navigate to:
${activeAmenitiesList}

### Tool contract

Pick exactly ONE tool. Every tool requires a \`text\` field — Ava's spoken response (1-2 natural sentences).

- **navigate_to_amenity_action({ amenityId, text })** — guest wants to LEAVE the current amenity and visit a DIFFERENT one. \`amenityId\` MUST exactly match an id in the Active amenities list above.
- **open_rooms_panel_action({ text })** — guest wants to see HOTEL ROOMS for their stay (i.e., bedrooms / suites to sleep in). Use only when the request is clearly about overnight accommodation.
- **list_amenities({ text })** — guest asks "what amenities do you have?" or similar listing question. Your \`text\` will be replaced by a canonical data-grounded listing — keep it brief.
- **show_hotel_overview({ text })** — guest wants the camera pulled back to the hotel overview.
- **change_lighting({ mode, text })** — daylight / sunset / night. Map evocative phrases ("golden hour" → sunset, "starlight" → night, "brighter" → daylight).
- **return_to_virtual_lounge({ text })** — explicit "back to the virtual lounge" request. The system will then ask the guest to confirm.
- **confirm_end_experience({ text })** — guest signals goodbye / "I'm done". The system asks for confirmation.
- **speak_only_action({ text })** — clarify, describe the current amenity, or answer factual questions without changing scenes. Default when ambiguous.
- **download_user_data({ text })** — admin command, rare.

### Resolving "book" utterances

The verb "book" is ambiguous here. Decide based on what is being booked:

1. "I'd like to book it" / "can I book this?" while in **${currentAmenityName}** → likely the AMENITY SPACE itself. The platform does NOT support amenity bookings. Emit **speak_only_action** clarifying and offering a next step.
2. "Book a room" / "I want to book a room" → about HOTEL ROOMS (sleeping accommodation). Emit **open_rooms_panel_action**.
3. "Book me into the spa" / "take me to book the conference" → the verb is loosely "take me to". Emit **navigate_to_amenity_action** with the named amenity's id.

When in doubt between (1) and (2), prefer **speak_only_action** with a brief clarifying question.

### Hard rules
- \`text\` is required. Empty is invalid.
- For navigate_to_amenity_action, \`amenityId\` MUST be one of the ids above.
- Never invent amenities. Never use "rooms" as an amenityId.
- 1-2 sentences. No filler preamble.`
  }

  if (stage === "HOTEL_EXPLORATION") {
    return `\n\n## HOTEL_EXPLORATION — action-dispatch (current stage)

The guest is at the hotel overview. They can ask to see rooms, amenities, location, change lighting, navigate to a specific amenity, or end / leave.

Active amenities the guest can navigate to:
${activeAmenitiesList}

### Tool contract

Pick exactly ONE tool. Every tool requires a \`text\` field — Ava's spoken response (1-2 natural sentences).

- **navigate_to_amenity_action({ amenityId, text })** — guest wants to enter a specific amenity space. \`amenityId\` MUST be from the Active amenities list above.
- **open_rooms_panel_action({ text })** — guest wants to see sleeping rooms / suites.
- **list_amenities({ text })** — guest asks "what amenities do you have?" / listing question. Your text will be replaced by a canonical data-grounded listing.
- **show_hotel_overview({ text })** — guest wants to return to / see the hotel overview ("go back", "show me the hotel").
- **open_map({ text })** — guest wants to see the location / surrounding area (generic; no specific category).
- **locate_interest_points({ category, text })** — guest asks about a specific category nearby ("kitesurfing", "romantic restaurants", "hiking trails"). \`category\` is a Places-API query.
- **change_lighting({ mode, text })** — daylight / sunset / night.
- **return_to_virtual_lounge({ text })** — explicit "back to the virtual lounge" request.
- **confirm_end_experience({ text })** — guest signals goodbye.
- **speak_only_action({ text })** — clarify, describe, or answer a factual property question without changing scenes. Default when ambiguous.
- **download_user_data({ text })** — admin command, rare.

### Worked examples

- "Show me the rooms" → \`open_rooms_panel_action({ text: "Bringing up the rooms now." })\`
- "Take me to the spa" → \`navigate_to_amenity_action({ amenityId: "<spa id>", text: "Right this way to the spa." })\`
- "What amenities do you have?" → \`list_amenities({ text: "Here's what we offer..." })\`
- "Change to sunset" → \`change_lighting({ mode: "sunset", text: "Golden hour it is." })\`
- "What's nearby?" → \`open_map({ text: "Here's the area. Tell me what you'd like to see nearby." })\`
- "Good restaurants?" → \`locate_interest_points({ category: "restaurants", text: "Let me find nearby restaurants." })\`
- "I'm done" → \`confirm_end_experience({ text: "It was a pleasure. Would you like to end the experience?" })\`
- "Tell me about this place" → \`speak_only_action({ text: "<grounded description>" })\`

### Hard rules
- Always include \`text\`. 1-2 sentences.
- For navigate_to_amenity_action, \`amenityId\` MUST exactly match an id above.
- Never invent amenities.`
  }

  if (stage === "ROOM_SELECTED") {
    const viewMode = body.journeyContext.viewMode
    const viewModeLabel = viewMode ?? "default (overview)"
    const room = body.selectedRoom
    const roomHeader = room
      ? `**${room.name}** (occupancy ${room.occupancy}, $${room.price}/night)`
      : "(no room currently selected — guest should pick a unit first)"

    return `\n\n## ROOM_SELECTED — action-dispatch (current stage)

The guest has selected a room: ${roomHeader}
Current view: **${viewModeLabel}**

### Tool contract

Pick exactly ONE tool. Every tool requires a \`text\` field.

- **step_into_unit({ text })** — switch to interior view. "go inside", "show me the room", "take me in".
- **step_out_of_unit({ text })** — switch to exterior view. "show me the view", "outside", "balcony view".
- **back_to_rooms_panel({ text })** — "go back", "show other rooms". If guest is currently in **exterior** view, the system steps back to interior. Otherwise opens the rooms panel.
- **open_booking_url({ text })** — guest commits to booking THIS room. "book it", "I'll take it", "let's reserve".
- **change_lighting({ mode, text })** — daylight / sunset / night.
- **open_rooms_panel_action({ text })** — guest wants to compare other rooms / different options.
- **show_hotel_overview({ text })** — guest wants to leave the room view entirely.
- **return_to_virtual_lounge({ text })** — explicit lounge request.
- **confirm_end_experience({ text })** — goodbye.
- **speak_only_action({ text })** — clarify, describe THIS room, answer questions about its features.
- **download_user_data({ text })** — admin, rare.

### Worked examples

- "Take me inside" → \`step_into_unit({ text: "Stepping inside now." })\`
- "Show me the view" → \`step_out_of_unit({ text: "Here's the view from the terrace." })\`
- "Book it" → \`open_booking_url({ text: "Opening the booking page now." })\`
- "What's the bed like?" → \`speak_only_action({ text: "<answer from selectedRoom.bedding>" })\`
- "Go back" while in **exterior** view → \`back_to_rooms_panel({ text: "Stepping back inside." })\` (reducer auto-routes to interior)
- "Show me another room" → \`open_rooms_panel_action({ text: "Of course — here are the other rooms." })\`

### Hard rules
- \`step_into_unit\` / \`step_out_of_unit\` require a selected unit (one is selected — see the room header above).
- 1-2 sentences. No filler.`
  }

  if (stage === "VIRTUAL_LOUNGE") {
    const sub = body.journeyContext.subState ?? "exploring"
    return `\n\n## VIRTUAL_LOUNGE — action-dispatch (current stage)

The guest is in the virtual lounge — a pre-hotel space showcasing artwork and retail. They have NOT yet entered the hotel. The lounge has NO hotel amenities (pool / spa / restaurant / lobby etc); those are inside the hotel and inaccessible from here.

Current sub-state: **${sub}**

### Tool contract

Pick exactly ONE tool. Every tool requires a \`text\` field.

- **travel_to_hotel({ text })** — guest is ready to enter the hotel. "let's go", "take me to the hotel", "I'm ready", "ready when you are".
- **explore_lounge_action({ text })** — guest said yes / sure / okay AFTER the avatar offered the lounge (only meaningful in sub-state "asking"). Confirms staying to explore the lounge.
- **navigate_to_amenity_action({ amenityId, text })** — guest implicitly wants to leave the lounge AND see a specific amenity. The system travels to the hotel first, then navigates to the amenity (~3.5s gap). \`amenityId\` from the Active list below.
- **open_rooms_panel_action({ text })** — guest wants to see hotel rooms. Triggers travel-then-open-rooms.
- **open_map({ text })** — guest wants the surrounding area. Triggers travel-then-open-map.
- **show_hotel_overview({ text })** — guest wants the hotel overview. Equivalent to travel_to_hotel.
- **speak_only_action({ text })** — guest wants to stay longer, asks about the art / retail, or says something off-topic. ALWAYS speak — never leave a turn silent.
- **confirm_end_experience({ text })** — explicit farewell.
- **download_user_data({ text })** — admin, rare.

Active amenities (only relevant if the guest names one):
${activeAmenitiesList}

### Sub-state guidance

When sub-state is "asking", the avatar just asked: "would you like to explore the virtual lounge first, or go straight to the hotel?"
- "yes" / "sure" / "show me" / "okay" → \`explore_lounge_action({ text: "Take your time in the lounge..." })\`
- "no" / "let's go to the hotel" / "I'm ready" → \`travel_to_hotel({ text: "Right this way to the hotel." })\`

When sub-state is "exploring":
- Any move-on phrasing ("I'm ready", "let's continue", "okay I'm done") → \`travel_to_hotel\`
- Lounge-content questions ("tell me about this piece") → \`speak_only_action\`
- Specific hotel content ("show me the pool", "let me see the rooms") → \`navigate_to_amenity_action\` / \`open_rooms_panel_action\` (system handles the travel-then-navigate sequence)

### Hard rules
- Never invent hotel amenities while in the lounge. Use one of the IDs above for navigate_to_amenity_action.
- Never produce a silent turn. Every action carries spoken text.`
  }

  if (stage === "DESTINATION_SELECT") {
    return `\n\n## DESTINATION_SELECT — action-dispatch (current stage)

The guest is looking at the destination grid (which hotels are available). This stage is primarily UI-driven — the guest taps a card to pick a hotel. Voice plays a supporting role.

### Tool contract

- **select_hotel({ hotelSlug, text })** — guest names a hotel by name. Use the slug if you recognize it; otherwise prefer \`speak_only_action\` and let the UI handle the selection.
- **speak_only_action({ text })** — guest asks a question, makes small talk, or says something not about hotel selection.
- **confirm_end_experience({ text })** — explicit farewell.
- **download_user_data({ text })** — admin, rare.

### Hard rules
- Only pick \`select_hotel\` when the guest names a hotel unambiguously. Otherwise speak_only_action.
- 1-2 sentences.`
  }

  if (stage === "END_CONFIRMING") {
    return `\n\n## END_CONFIRMING — action-dispatch (current stage)

The avatar just asked: "Would you like to end your experience now?"

### Tool contract

- **end_experience_affirm({ text })** — guest confirmed (yes / "I'm done" / "goodbye"). Speak a warm farewell.
- **end_experience_cancel({ text })** — guest changed their mind (no / "actually no" / "let's keep going"). Speak a brief acknowledgment.
- **speak_only_action({ text })** — off-topic or unrelated reply; speak briefly without ending. (The reducer ignores other actions in this stage.)

### Hard rules
- Only pick affirm / cancel when the guest's reply is clearly yes or no.
- Speech 1-2 sentences.`
  }

  if (stage === "LOUNGE_CONFIRMING") {
    return `\n\n## LOUNGE_CONFIRMING — action-dispatch (current stage)

The avatar just asked: "Return to the virtual lounge? You'll leave the hotel for now."

### Tool contract

- **lounge_return_affirm({ text })** — guest confirmed they want to go back to the lounge. Speak a brief acknowledgment.
- **lounge_return_cancel({ text })** — guest changed their mind / wants to stay in the hotel.
- **speak_only_action({ text })** — off-topic reply; speak briefly without transitioning.

### Hard rules
- Only pick affirm / cancel when the guest's reply is clearly yes or no.
- Speech 1-2 sentences.`
  }

  return ""
}

function buildSystemPrompt(body: RequestBody, reconstructed: ReconstructedProfile): string {
  const isProfileCollection = body.journeyContext.stage === "PROFILE_COLLECTION"
  if (isProfileCollection) return buildProfileCollectionPrompt(body)
  const hasRooms = body.rooms && body.rooms.length > 0

  // --- Room catalog block (only when rooms are provided) ---
  let roomBlock = ""
  if (hasRooms) {
    const roomCatalog = body.rooms!
      .map((r) => `  - ${r.name} (id: "${r.id}", occupancy: ${r.occupancy}, price: $${r.price}/night)`)
      .join("\n")
    roomBlock = `\n\n## Available rooms\n\n${roomCatalog}`
  }

  // --- Selected room details block ---
  let selectedRoomBlock = ""
  if (body.selectedRoom) {
    const entries: string[] = []
    for (const [key, value] of Object.entries(body.selectedRoom)) {
      if (value === undefined || value === null) continue
      if (typeof value === "object") {
        entries.push(`- ${key}: ${JSON.stringify(value)}`)
      } else {
        entries.push(`- ${key}: ${String(value)}`)
      }
    }
    if (entries.length > 0) {
      selectedRoomBlock =
        `\n\n## Selected room details\n` +
        `This is the room currently selected in the room flow. Use these fields when answering feature questions.\n\n` +
        `${entries.join("\n")}`
    }
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

### Skip-ahead exception (check FIRST every turn)

If the guest's latest turn explicitly asks to skip ahead — e.g. "show me the rooms / hotel / amenities / surrounding area / lobby / spa / pool", "take me to the hotel / rooms", "I want to see X", "let's go straight to the hotel" — emit \`navigate_and_speak\` instead of \`profile_turn\`, with the matching intent:

- "show me the rooms" / "take me to a room" / "I want to book a room" / "book it" / "reserve the suite" → \`intent: "ROOMS"\` (or \`"BOOK"\`)
- "show me the amenities" / "what amenities do you have" → \`intent: "AMENITIES"\`
- a specific amenity name (pool, spa, restaurant, lobby, conference, gym, bar, lounge, dining) → \`intent: "AMENITY_BY_NAME"\` with \`amenityName\`
- "book / reserve a {amenity}" — "book a conference room", "book a restaurant", "reserve the spa", "book a table" → \`intent: "AMENITY_BY_NAME"\` with the named amenity, NOT \`BOOK\`. "book" maps to \`BOOK\` only when the object is the stay itself (a room/suite/it/this).
- "show me the surrounding area" / "what's around" / "the location" → \`intent: "LOCATION"\`
- "show me the hotel" / "let me see the property" / generic "let's go" → \`intent: "HOTEL_EXPLORE"\` (or \`"TRAVEL_TO_HOTEL"\`)

Speech for the skip-ahead should briefly acknowledge and lead in (e.g. "Of course — I'll bring up the rooms now."). Do NOT ask another profile question. The client will travel to the hotel and surface the requested view.

Otherwise (the default for this stage), use \`profile_turn\` as described below.

### Your job each turn

Return exactly one \`profile_turn\` tool call (or \`navigate_and_speak\` per the skip-ahead rule above). The transcript above is the source of truth — extract every profile field the guest has revealed across ALL their turns, not just the latest one. The "Current profile state" block below may be stale, partial, or outright wrong; always trust the transcript first.

\`profile_turn\` has four fields, produced in this order:

1. \`reasoning\` — REQUIRED. Write this FIRST. 1-2 short sentences (max ~250 chars) of internal monologue: what's missing and why your decision and speech are correct. This is a thinking pad, not spoken aloud. Be terse — long reasoning blocks slow the avatar's response without improving quality.
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
- Party: "2 adults and 4 children" → \`partySize: 6, guestComposition: { adults: 2, children: 4 }\`. "8 guests" alone (no decomposition) → \`partySize: 8\` only; leave guestComposition for a follow-up.
- **Adults-only decomposition**: "8 adults" / "just the two of us, all adults" / "four grown-ups" → \`partySize: N, guestComposition: { adults: N, children: 0 }\`. Always set \`children: 0\` EXPLICITLY — never emit \`{ adults: N }\` without children. Downstream schemas require both fields.
- **All-adults follow-up**: if a prior turn captured partySize but not composition, and the latest turn says "all adults" / "just adults" / "no kids" / "no little ones", decompose: \`guestComposition: { adults: partySize, children: 0 }\`.
- Ages: "2, 4, 6, and 8" or "2, 4, 6, 8" for 4 children → \`childrenAges: [2, 4, 6, 8]\`. When the latest guest turn is bare numbers AND a previous avatar turn asked about ages, treat them as ages.
- Age mismatch: if guest gave fewer/more ages than children count, or a range like "between 12 and 16" for 4 kids → \`decision: "clarify"\`. Do NOT silently accept.
- Room distribution: "all in one room" → \`roomAllocation: [partySize]\`. "separate rooms" → \`[1,1,...]\` (partySize ones). "two rooms, four and two" → \`[4, 2]\`. "evenly" with partySize 8 across 2 rooms → \`[4, 4]\`. Bare "N rooms" (e.g. "4 rooms" for partySize 8) → \`[partySize/N, partySize/N, ...]\` when evenly divisible, else ask to clarify the split.

### Transcription-artifact rule (HeyGen VAD splitting)

The speech-to-text sometimes chunks one user utterance into two turns, ending the first with a comma, dash, or mid-word cut-off: "All adults—", "we will be eight ad—", "and, uh,". Treat such cut-offs as non-signal, NOT as ambiguity warranting \`"clarify"\`.

- If the MOST RECENT turn looks incomplete OR merely restates something already captured, combine it with prior turns and proceed to \`ask_next\` / \`ready\`.
- Example: prior turn "we will be 8 adults", latest turn "All adults—" → composition fully captured (adults=8, children=0); do NOT ask "confirm the exact number of adults". Ask the NEXT missing field instead.
- Example: prior turn "between May 10 and 15", latest turn "the—" → dates captured; move on.
- Only emit \`"clarify"\` when the composite of ALL turns genuinely fails to yield the answer.

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
- WRONG: \`{ profileUpdates: { guestComposition: { adults: 4, children: 4, childrenAges: [12, 13, 14, 15] } }, decision: "ready", speech: "Great, I've noted the children's ages. Before we head to the hotel, shall we explore the virtual lounge?" }\`
- RIGHT: \`{ profileUpdates: {}, decision: "clarify", speech: "Could you tell me each child's age individually rather than a range?" }\`

Profile only has partySize + guestComposition; dates, travel purpose, room allocation are all missing:
- WRONG: \`{ decision: "ready", speech: "Lovely, shall we stop by the virtual lounge first?" }\` (the OTHER required fields are still missing — decision must be "ask_next")
- RIGHT: \`{ decision: "ask_next", speech: "What are your travel dates?" }\`

Guest said "mid-June":
- WRONG: \`{ profileUpdates: { startDate: "2026-06-15", endDate: "2026-06-20" }, decision: "ask_next", ... }\` (inventing a specific range)
- RIGHT: \`{ profileUpdates: {}, decision: "clarify", speech: "Could you give me specific arrival and departure days in June?" }\`

Guest said "8 guests" and "4 are children":
- WRONG: decision "ready" (travelPurpose, dates, roomAllocation still missing)
- RIGHT: \`{ profileUpdates: { partySize: 8, guestComposition: { adults: 4, children: 4 } }, decision: "ask_next", speech: "What are your travel dates?" }\` (or ask for ages first, both acceptable)

### Ask-next style (when decision = "ask_next")

- Start directly with the question. Never preface with acknowledgment phrases like "Got it", "Great", "Perfect", "Wonderful", "Lovely", "Noted", "Thank you for sharing", "Excellent", "Amazing", "Awesome".
- Ask ONE thing per turn. The only exception is asking for dates + guests at the very start when both are missing.
- 1-2 sentences. Spoken aloud, not typed.

### Ready-handoff style (when decision = "ready")

- Produce a warm 1-2 sentence handoff that restates 2-4 captured details AND offers the virtual lounge before the hotel. The next stage is the virtual lounge (exclusive artwork and retail on display), NOT the hotel — every ready handoff must end with an invitation to visit the lounge or skip straight to the hotel.
- Do NOT say "let me take you to the hotel", "let's head to the hotel", or "let's head over" on its own — those mislead the guest into expecting the hotel when the next prompt is about the lounge.
- Examples:
  - "Wonderful — May 10 to 15, four adults and four children, split two and two. Before we head to the hotel, would you like to stop by the virtual lounge? We have some exclusive artwork and retail on display."
  - "May 10 to 15, the four of you for a family trip. Shall we explore the virtual lounge first for a look at some art and retail, or go straight to the hotel?"

### Do not

- Do not ask for firstName, lastName, email, phone, or date of birth — those are already known from login.
- Do not invent hotel facts, room names, prices, or amenities.
- Do not produce \`decision: "ready"\` unless every required field is satisfied.

### Current profile state (may be partial/stale — trust the transcript first)
${collectedSummary}`
  }

  // Phase 3: surface the client-side regex-classifier hint when present. The
  // LLM is free to override but should prefer the hint on clear matches. In
  // PROFILE_COLLECTION the hint is also a strong signal that the guest may be
  // asking to skip ahead (see the skip-ahead exception block).
  let regexHintBlock = ""
  if (body.regexHint && body.regexHint !== "UNKNOWN") {
    regexHintBlock = `\n\nRegex classifier hint (use as a tiebreaker; override only if the conversation makes it clear the hint is wrong): ${body.regexHint}`
  }

  // Hotel-overview block — grounds the LLM's answers to "tell me about this
  // hotel" / "where is it?" / "what makes this place special?". Renders for
  // every non-PROFILE_COLLECTION turn so it's available across HOTEL_EXPLORATION,
  // AMENITY_VIEWING, ROOM_SELECTED, VIRTUAL_LOUNGE, and DESTINATION_SELECT.
  let hotelOverviewBlock = ""
  if (!isProfileCollection && body.hotelInfo) {
    const h = body.hotelInfo
    const lines: string[] = []
    lines.push(`You are guiding a guest through ${h.name} in ${h.location}.`)
    if (h.tagline) lines.push(h.tagline)
    if (h.description) lines.push(h.description)
    if (h.highlights && h.highlights.length > 0) {
      lines.push("")
      lines.push("Highlights:")
      for (const hl of h.highlights) lines.push(`- ${hl}`)
    }
    if (h.address) {
      const addr = `${h.address.city}, ${h.address.region}, ${h.address.country}`
      lines.push("")
      lines.push(`Address: ${addr}.`)
    }
    if (h.websiteUrl) lines.push(`Website: ${h.websiteUrl}`)
    lines.push("")
    lines.push(
      "When the guest asks a generic question about the hotel (\"tell me about this hotel\", \"what makes this place special\"), draw from this block. Speak conversationally — pick 1-2 highlights, don't recite the list. Mention the address only when the guest asks \"where is this?\" or similar.",
    )
    lines.push(
      "Do NOT phrase any highlight as a place the guest can step into / visit / see / tour unless the underlying facility appears in the Visitable amenities list below. Highlights that name a Described-only facility (e.g. the spa, a restaurant, the gym) must be framed as property credentials or atmosphere only — never as something the guest will walk into in this experience.",
    )
    hotelOverviewBlock = `\n\n## Hotel overview (ground truth)\n\n${lines.join("\n")}`
  }

  // Hotel-amenities grounding block (two-section).
  //
  // The intent-classification section lists AMENITY_BY_NAME's enum values
  // (pool, spa, restaurant, lobby, conference, gym, bar, lounge, dining) as
  // *categories* for classification. Without grounding, the LLM was reading
  // that as a menu of amenities the property offers and freestyled "we have
  // a pool, spa, dining, and gym" when asked "what amenities do you have?".
  //
  // The new two-section structure separates amenities the guest can NAVIGATE
  // to (UE5 scene exists) from amenities that EXIST at the property but
  // aren't part of the live tour (no scene). The LLM must describe both
  // when asked but only call navigation tools on the navigable list.
  let hotelAmenitiesBlock = ""
  const isHotelContext =
    body.journeyContext.stage === "HOTEL_EXPLORATION" ||
    body.journeyContext.stage === "AMENITY_VIEWING" ||
    body.journeyContext.stage === "ROOM_SELECTED" ||
    body.journeyContext.stage === "VIRTUAL_LOUNGE"
  const active = body.hotelAmenitiesActive ?? []
  const describedOnly = body.hotelAmenitiesDescribedOnly ?? []
  const hasRichAmenityCtx = active.length > 0 || describedOnly.length > 0

  if (isHotelContext && hasRichAmenityCtx) {
    const sections: string[] = []
    if (active.length > 0) {
      sections.push(
        `### Visitable in the live tour (these CAN be navigated to)\n\n${active.map(renderAmenityListItem).join("\n")}`,
      )
    }
    if (describedOnly.length > 0) {
      sections.push(
        `### Described only — NOT part of the live tour (do NOT navigate)\n\n${describedOnly.map(renderAmenityListItem).join("\n")}`,
      )
    }

    const navigableNames = active.map((a) => a.name).join(", ") || "(none)"
    const describedNames = describedOnly.map((a) => a.name).join(", ") || "(none)"

    sections.push(`### Speech rules

When the guest asks ABOUT an amenity in EITHER list, describe it warmly — pick 1-2 highlights, mention category fit (e.g. "the spa is wellness-focused"), keep to 2-3 sentences.

When the guest asks to GO TO / VISIT / SHOW / TOUR an amenity:
- If it's in the Visitable list (${navigableNames}): emit \`navigate_and_speak\` with intent \`AMENITY_BY_NAME\` and the canonical name. Speak briefly as you advance.
- If it's in the Described-only list (${describedNames}): emit \`no_action_speak\`, describe the amenity richly using its shortDescription/highlights, and add a short in-character note that the live tour doesn't include this space yet, then offer a Visitable amenity instead. Example: "I can tell you all about the Longevity Spa — though the live tour doesn't reach the spa space just yet. Would you like me to take you to the pool?" Never break the fourth wall (no "the UE5 scene isn't built"). Never claim the amenity doesn't exist — it does, just not in the immersive walk.
- If the guest asks a listing-style question — "what amenities do you have?", "list your facilities", "tell me about your amenities", "any amenities?" — you MUST emit \`navigate_and_speak\` with \`intent: "AMENITIES"\`. Do NOT use \`no_action_speak\` for these (it produces a generic placeholder that bypasses the canonical listing). The reducer will replace your speech with a data-grounded list of every active and described-only amenity, so keep your own speech minimal — a single short lead-in is fine.

Never invent an amenity not in either list. Never offer to navigate to an amenity in the Described-only list.`)

    hotelAmenitiesBlock = `\n\n## Hotel amenities (ground truth)\n\n${sections.join("\n\n")}`
  } else if (isHotelContext && body.hotelAmenityNames && body.hotelAmenityNames.length > 0) {
    // Legacy fallback: rich lists missing but the legacy names array is
    // present. Mirrors the pre-Phase-3 grounding behaviour.
    const amenityList = body.hotelAmenityNames.join(", ")
    hotelAmenitiesBlock = `\n\n## Hotel amenities (ground truth)

This property has exactly these amenities available in the live tour: ${amenityList}.

Never mention, recommend, or offer any amenity not in this list as something the guest can VISIT. If they ask to visit an amenity not in the list (e.g., "take me to the spa"), acknowledge it's not part of the live tour and offer one that IS.`
  } else if (isHotelContext) {
    hotelAmenitiesBlock = `\n\n## Hotel amenities (ground truth)

This property has no bookable amenity spaces to tour. If the guest asks, acknowledge that and redirect to rooms or the surrounding area. Do NOT invent amenities (no spa, gym, restaurant, etc.).`
  }

  // Focused-amenity block — when the guest's latest message names a specific
  // amenity, inject its FULL data so the LLM can describe it richly. Mirrors
  // the rooms / selectedRoom pattern: condensed list always, full details
  // only on focus, keeping the prompt's per-turn token cost bounded.
  let selectedAmenityBlock = ""
  if (isHotelContext && hasRichAmenityCtx) {
    const focused = detectFocusedAmenity(body.message, active, describedOnly)
    if (focused) {
      const tag = focused.navigable
        ? "Visitable amenity (navigable)"
        : "Described-only amenity (NOT navigable — do not call AMENITY_BY_NAME for this one)"
      selectedAmenityBlock =
        `\n\n## Focused amenity details (${tag})\n` +
        `The guest's latest message references this amenity by name. Use the full detail below when answering. Keep speech to 2-3 sentences — pick the most relevant 1-2 highlights, don't dump the whole record.\n\n` +
        renderAmenityFullDetail(focused.amenity)
    }
  }

  // AMENITY_VIEWING stage-specific guidance.
  //
  // The guest has just been navigated to one of the hotel's amenity spaces
  // (pool / lobby / conference room). The journey state computes a
  // `suggestedNext` amenity mechanically (first unvisited one). The LLM is
  // the sole authority on what a guest's "yes" means in this stage —
  // whether they want to stay for more details or advance to suggestedNext.
  // The client reducer used to auto-advance on AFFIRMATIVE when
  // suggestedNext was set; that produced a "said yes, got teleported" UX
  // when the avatar's speech had invited "want to know more?".
  //
  // When `body.experiment === "action-dispatch"` we skip this block entirely
  // — the unified `experimentBlock` (below) provides the per-stage tool
  // contract and supersedes both intent-classification and tool-selection
  // guidance for that turn.
  let amenityViewingBlock = ""
  if (body.journeyContext.stage === "AMENITY_VIEWING" && body.experiment !== "action-dispatch") {
    const currentAmenityName =
      body.journeyContext.currentAmenity?.name ?? body.journeyContext.suggestedAmenityName
    const suggestedNext = body.journeyContext.suggestedNext

    amenityViewingBlock = `\n\n## AMENITY_VIEWING stage guidance (current stage)

The guest is touring a specific amenity space right now.${suggestedNext ? ` The next unvisited amenity the client wants to surface is: **${suggestedNext}**.` : " No further unvisited amenity is queued."}${currentAmenityName ? ` (Context: currently viewing amenity "${currentAmenityName}".)` : ""}

### Intent contract for this stage (critical)

Your tool choice and intent tag MUST match what your speech proposes. The reducer will NOT guess. Pick ONE of the three patterns below per turn.

1. **Advance to the next amenity** — when the guest clearly wants to move on (either they named another amenity, or they said "yes" after you offered suggestedNext): emit \`navigate_and_speak\` with \`intent: "AMENITY_BY_NAME"\` and \`amenityName: "${suggestedNext ?? "<name>"}"\`. Your speech should mention that amenity by name so the guest hears what they're being taken to.

2. **Stay and elaborate on the current amenity** — when the guest wants more details, asks a question about the current amenity, or says "yes" after you offered "want to know more about this?": emit \`no_action_speak\` with 1-3 sentences of actual content about the current amenity. Do NOT emit AFFIRMATIVE / AMENITY_BY_NAME here — you are not navigating, you are elaborating.

3. **Back to hotel overview / other navigation** — use \`navigate_and_speak\` with the matching intent (\`BACK\`, \`HOTEL_EXPLORE\`, \`ROOMS\`, \`LOCATION\`, etc).

### Self-consistency rule

Before emitting, sanity-check: does the speech you're about to produce invite the same action your intent implies?
- Speech "Shall we head to the ${suggestedNext ?? "next amenity"}?" → intent \`AMENITY_BY_NAME\` on the guest's "yes" next turn.
- Speech "Would you like to hear more about the pool?" → on the guest's "yes" next turn, use \`no_action_speak\` with actual pool details. Do NOT suddenly switch to AMENITY_BY_NAME.

When in doubt, prefer speech that proposes advancement to suggestedNext (if available) — it's the more common intent at this stage.

### Hard don'ts

- Do NOT emit bare \`USER_INTENT: AFFIRMATIVE\` in this stage. It's ambiguous without a binding prior proposal, and the reducer will not auto-advance on it anymore. Either commit to AMENITY_BY_NAME (advance) or no_action_speak (stay).`
  }

  // VIRTUAL_LOUNGE stage-specific guidance.
  //
  // The reducer's VIRTUAL_LOUNGE:exploring branch routes only TRAVEL_TO_HOTEL,
  // NEGATIVE, AFFIRMATIVE, and a small set of hotel-content intents into state
  // transitions — everything else is ignored. Without explicit guidance the
  // LLM tends to mis-classify lounge-exit phrasings ("I'm ready", "let's go",
  // "take me to the hotel") as AMENITY_BY_NAME / AFFIRMATIVE / UNKNOWN,
  // which the reducer then drops silently. This block forces the correct
  // tag selection at exit-time and pushes off-topic / stay-longer utterances
  // into `no_action_speak` so the `=on` handler's speech path keeps the
  // avatar audible.
  let virtualLoungeBlock = ""
  if (body.journeyContext.stage === "VIRTUAL_LOUNGE" && body.experiment !== "action-dispatch") {
    const sub = body.journeyContext.subState ?? "exploring"
    virtualLoungeBlock = `\n\n## VIRTUAL_LOUNGE stage guidance (current stage)

The guest is currently in the virtual lounge — a pre-hotel space showcasing exclusive artwork and retail pieces. They have NOT yet entered the hotel. The lounge contains NO hotel amenities (pool, spa, restaurant, lobby, conference, gym, bar); those live inside the hotel and are inaccessible from here.

Current sub-state: ${sub}

### When sub-state is "asking"

The avatar just asked: "would you like to explore the virtual lounge first, or go straight to the hotel?" The guest's reply drives the transition:

- AFFIRMATIVE ("yes", "sure", "let's see it", "show me", "okay") — classify as AFFIRMATIVE. They'll stay in the lounge and free-roam.
- NEGATIVE ("no", "skip it", "not now") OR any explicit desire for the hotel ("take me to the hotel", "let's go to the hotel", "I'm ready", "straight to the hotel") — classify as TRAVEL_TO_HOTEL. They'll advance into the hotel.

### When sub-state is "exploring"

The guest is free-roaming the lounge. Any utterance signalling readiness to move on — "I'm ready", "let's go", "take me to the hotel", "okay I'm done", "next", "continue", "that's enough", "on to the hotel", "let's continue", "shall we go?" — MUST be classified as TRAVEL_TO_HOTEL (via navigate_and_speak). Do NOT use AFFIRMATIVE, AMENITY_BY_NAME, BACK, or UNKNOWN for these — the reducer only advances on TRAVEL_TO_HOTEL / NEGATIVE / AFFIRMATIVE here, and getting the tag wrong drops the transition silently.

If the guest wants to stay longer, asks about the art or retail, or says something off-topic ("what's the weather?", "tell me about this piece", "how much is that sculpture?"), use the **no_action_speak** tool with a brief engaging response. NEVER leave a turn silent — every exploring-stage turn must produce audible speech either by advancing (TRAVEL_TO_HOTEL) or speaking via no_action_speak.

### Hard don'ts for this stage

- Do NOT classify generic lounge-exit phrasings as AMENITY_BY_NAME. The lounge has no hotel amenities; the amenity-name enum values (pool, spa, restaurant, lobby, etc.) are hotel-only.
- If the guest asks about a hotel amenity by name while in the lounge ("take me to the pool"), treat it as TRAVEL_TO_HOTEL — they're implying they want to leave the lounge for the hotel. Mention in speech that the hotel is next so the transition feels coherent.
- Do NOT classify bare "let's go" / "I'm ready" as AFFIRMATIVE during exploring — there is no standing yes/no proposal in that sub-state. Use TRAVEL_TO_HOTEL.`
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
  // Phase 9: all three tools (`navigate_and_speak`, `no_action_speak`,
  // `profile_turn`) accept `profileUpdates`. Mid-exploration corrections
  // ("we're 6 not 8", "switch to May 15–20") are persisted by setting that
  // field on whichever tool the LLM is calling this turn.
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

When you detect a correction or supplement (e.g., "we're 6 not 8", "switch to May 15–20", "actually mom is joining too"), ALSO set the \`profileUpdates\` field on whichever tool you're calling this turn with the corrected field(s). Only include fields that actually changed from the reconstructed profile; omit everything else. This is how mid-journey corrections get persisted — don't just mention the correction in speech and move on.`
  }

  // Action-dispatch experiment per-stage block. When set, supersedes the
  // legacy intent-classification + tool-selection guidance in the system
  // prompt. The legacy amenityViewingBlock / virtualLoungeBlock are gated
  // off above for these turns; the experiment block is the sole source of
  // tool guidance.
  const experimentBlock =
    body.experiment === "action-dispatch" ? buildActionDispatchPromptBlock(body) : ""

  return `You are Ava, an AI concierge for a luxury hotel metaverse experience. Given a user message and journey context, you must do TWO things in a single call: (1) classify what the user wants, and (2) generate a natural spoken response.

Call exactly one of the provided tools.

## Intent Classification Rules

Classify the user's intent into exactly one of these categories:

- **ROOMS**: User wants to see rooms, suites, or accommodation options.
- **AMENITIES**: User wants to see the list of amenities or facilities (generic request).
- **AMENITY_BY_NAME**: User mentions or refers to a specific amenity (pool, spa, restaurant, lobby, conference, gym, bar, lounge, dining) — including paraphrases like "swimming area" → pool, "eat" / "food" → restaurant, "work out" → gym. You MUST also return the canonical amenity name (one of: pool, spa, restaurant, lobby, conference, gym, bar, lounge, dining) in the "amenityName" field.
- **LOCATION**: Reserved for rare cases where the guest wants a generic look at the area AND has no stored interests AND you've already asked them once which category they'd like. In normal flow you should NOT pick LOCATION — prefer LOCATE_INTEREST_POINTS (when you can derive a category) or no_action_speak (when you need to ask). See the "Surrounding-area routing" section below.
- **LOCATE_INTEREST_POINTS**: User wants to find a specific TYPE of place near the hotel — restaurants, kitesurfing spots, museums, hiking trails, golf courses, beaches, etc. Also use this when the guest asks generically about the area ("show me what's around", "the surroundings") AND \`Guest context > Interests\` lists one or more interests — derive the \`category\` from the strongest interest (e.g. interest "hiking" → category "hiking trails"; interest "art" → category "art galleries"; interest "food" → category "restaurants"). You MUST set the \`category\` field to a short Places-API-friendly query (e.g. "kitesurfing locations", "romantic restaurants in Bellagio", "art galleries", "hiking trails"). Normalize colloquial phrasing: "where can we eat fancy?" → "michelin restaurants", "any spots to kite?" → "kitesurfing locations", "what about old churches?" → "historic churches". ONLY valid in HOTEL_EXPLORATION, ROOM_SELECTED, and AMENITY_VIEWING.
- **INTERIOR**: User wants to see the interior / inside view of a room or space.
- **EXTERIOR**: User wants to see the exterior / outside view of a room or space.
- **BACK**: User wants to go back, return to a previous view, or cancel current action.
- **HOTEL_EXPLORE**: User wants a general overview / tour of the hotel property (bird's eye view, zoom out, explore the hotel).
- **DOWNLOAD_DATA**: User explicitly requests to download their user data.
- **BOOK**: User wants to book, reserve, or proceed with a reservation **for their stay** — i.e., a room. Examples: "book it", "book the room", "I'll take this one", "let's reserve the suite", "sign me up", "make a reservation". **Do NOT use BOOK when the verb's object is an amenity** ("book a conference room", "book a restaurant", "reserve the spa", "book a table") — those are AMENITY_BY_NAME with the named amenity.
- **AFFIRMATIVE**: User agrees, says yes, confirms, or accepts a proposal.
- **NEGATIVE**: User declines, says no, refuses, or rejects a proposal.
- **TRAVEL_TO_HOTEL**: User wants to proceed to the hotel building itself (NOT a specific room or amenity within it). Typically used when leaving the lounge. Examples: "I'm ready", "let's go", "take me to the hotel", "let's continue". If the user says "take me to the [specific amenity]" (e.g., "take me to the pool"), that is AMENITY_BY_NAME, not TRAVEL_TO_HOTEL. **Hotel-intro speech rule**: whenever your \`navigate_and_speak\` emits TRAVEL_TO_HOTEL, the guest is about to enter the hotel for the first time this session — your speech MUST briefly cover (a) what's available to explore (rooms, amenities, grounds), (b) that they can switch the lighting to daylight, sunset, or night any time, including by using the toggle on your right, and (c) that they can return to the virtual lounge whenever they want. One warm paragraph — don't bullet-list.
- **OTHER_OPTIONS**: User wants to see other options, alternatives, or something different.
- **ROOM_TOGETHER**: User wants guests to share rooms or stay together.
- **ROOM_SEPARATE**: User wants separate / individual rooms for guests.
- **ROOM_AUTO**: User wants the system to decide room distribution (e.g., "you decide", "whatever works").
- **ROOM_PLAN_CHEAPER**: User wants a cheaper / more affordable room plan.
- **ROOM_PLAN_COMPACT**: User wants fewer rooms / a more compact room arrangement.
- **RETURN_TO_LOUNGE**: User wants to go back to the virtual lounge / lobby / gallery.
- **END_EXPERIENCE**: User wants to end the session, say goodbye, or leave.
- **LIGHTING_CHANGE**: User asks to change the lighting, ambience, mood, atmosphere, or time-of-day feel **without naming a specific mode**. Examples: "change the lighting", "different mood in here", "can we adjust the atmosphere", "make it feel different". ONLY valid in HOTEL_EXPLORATION, ROOM_SELECTED, and AMENITY_VIEWING — never in PROFILE_COLLECTION or VIRTUAL_LOUNGE (fall back to no_action_speak there).
- **LIGHTING_SET**: User names (or confirms) a specific lighting mode. You MUST also set \`lightingMode\` to one of: "daylight", "sunset", "night". Map evocative phrases: "morning light" / "brighter" / "daytime" → daylight; "golden hour" / "dusk" / "twilight" / "romantic" / "moody" → sunset; "after dark" / "starlight" / "evening" / "darker" / "nighttime" → night. ONLY valid in HOTEL_EXPLORATION / ROOM_SELECTED / AMENITY_VIEWING.
- **UNKNOWN**: The message does not match any of the above intents.

### Intent Disambiguation Rules

1. **Do NOT resolve AFFIRMATIVE / NEGATIVE contextually.** If the user says "yes", "sure", "no thanks", etc. without mentioning a specific feature, return AFFIRMATIVE or NEGATIVE. The journey state machine handles context resolution (lastProposal, suggestedNext) — the classifier must not duplicate that logic.
2. Only return AMENITY_BY_NAME when the user's message itself references a specific amenity. A bare "yes" with a suggestedAmenityName in context is still AFFIRMATIVE.
3. Use UNKNOWN only when the message genuinely does not map to any intent.
4. **AMENITY_BY_NAME takes priority over TRAVEL_TO_HOTEL.** If the message mentions a specific amenity or facility ("take me to the pool", "go to the lobby", "let's visit the conference room"), classify as AMENITY_BY_NAME, not TRAVEL_TO_HOTEL. TRAVEL_TO_HOTEL only applies when the destination is "the hotel" generically.
5. **AMENITY_BY_NAME takes priority over BOOK when "book"/"reserve" has an amenity object.** "Book a conference room" → AMENITY_BY_NAME (conference), not BOOK. "Reserve the spa" → AMENITY_BY_NAME (spa). "Book a table at the restaurant" → AMENITY_BY_NAME (restaurant). BOOK is only correct when the object of the verb is the stay itself — "book it", "book the room", "book the suite", "book this one". When in doubt, prefer AMENITY_BY_NAME — the user is asking for that amenity, the system will surface it, and from there they can book if they want.

## Surrounding-area routing (LOCATION → LOCATE_INTEREST_POINTS)

When the guest asks about the surrounding area, neighbourhood, or what's nearby ("show me the area", "what's around here", "what's outside the hotel", "tell me about the surroundings") — DO NOT emit \`LOCATION\`. Route via one of these two paths:

1. **Interests are known** (\`Guest context > Interests\` lists one or more entries): emit \`navigate_and_speak\` with \`intent: "LOCATE_INTEREST_POINTS"\` and \`category\` derived from the strongest matching interest. Map interests to Places-API-friendly categories: "hiking"/"outdoors" → "hiking trails"; "food"/"dining"/"culinary" → "restaurants"; "art"/"culture" → "art galleries"; "history" → "historic landmarks"; "shopping" → "boutique shops"; "wellness"/"spa" → "spas"; "wine" → "wineries"; "nightlife" → "bars and clubs"; "watersports" → "watersport rentals". When in doubt, pick the closest natural Places query. Speech should briefly acknowledge their interest and announce the lookup, e.g. "You mentioned hiking — let me put the best trails on the map." (1 short sentence; the system will follow up with a count once results land.)

2. **No interests on file** (\`Guest context > Interests\` is absent or empty): emit \`no_action_speak\` with speech that asks what they'd like to see nearby. Offer 3-4 example categories so the guest knows the surface is clickable, e.g. "I can drop restaurants, hiking trails, museums, or anything else nearby on the map — what would you like to see?" Do NOT open the map yet. On their reply naming a category, the next turn will route to \`LOCATE_INTEREST_POINTS\` normally.

The bare \`LOCATION\` intent (which only opens the panel with no markers) is a last-resort fallback — only use it if the guest has explicitly refused the question above twice OR they say something like "just show me the map, no specific category".

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

- Use **navigate_and_speak** for navigation intents (ROOMS, BACK, AMENITY_BY_NAME, AFFIRMATIVE, NEGATIVE, TRAVEL_TO_HOTEL, ROOM_TOGETHER, ROOM_SEPARATE, ROOM_PLAN_CHEAPER, ROOM_PLAN_COMPACT, etc.).
- Use **no_action_speak** when the message doesn't map to any navigation intent — just generate a helpful spoken response.
- **Room plan changes are handled by a dedicated client-side planner system**, not by this route. Do NOT try to compose a room plan here. When the guest asks for cheaper rooms, more compact rooms, specific room types, or a different distribution, just classify the utterance with \`navigate_and_speak\` (using the appropriate ROOM_* intent when one fits, otherwise UNKNOWN) and generate brief acknowledging speech. The client's room planner will read the transcript and update the rooms panel.

## Profile Corrections (all stages)

If during any turn the user corrects or supplements profile data (examples: "we're 6 not 8", "actually mom is joining too", "switch to May 15–20", "call me Lisa not Cesar"), set the optional \`profileUpdates\` field on whichever tool you're calling with the corrected field(s). Do NOT use \`profile_turn\` for mid-exploration corrections — only use \`profileUpdates\` on the tool that fits the user's primary intent (usually \`navigate_and_speak\` or \`no_action_speak\`). Only include fields that changed — omit everything else. Profile writes are idempotent and safe to emit alongside any action.${regexHintBlock}${roomBlock}${selectedRoomBlock}${hotelOverviewBlock}${hotelAmenitiesBlock}${selectedAmenityBlock}${guestBlock}${transcriptReconstructionBlock}${virtualLoungeBlock}${amenityViewingBlock}${experimentBlock}${profileCollectionBlock}`
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

type ProfileValidatorOverride =
  | "ages_mismatch"
  | "ready_premature"
  | "ask_next_mismatch"
  | "ask_next_complete"

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
  dates: "What are your travel dates?",
  guests: "How many guests are traveling?",
  guest_breakdown: "How many adults and children are in your group?",
  children_ages: "What are the children's ages?",
  travel_purpose: "What brings you to the area?",
  room_distribution: "How would you like to split your guests across rooms?",
}

function buildMergedProfileState(
  updates: ProfileUpdatesT,
  body: RequestBody,
): MergedProfileState {
  const mergedGuestComposition = updates.guestComposition
    ? ({
        ...(body.guestComposition ?? {}),
        ...updates.guestComposition,
      } as MergedProfileState["guestComposition"])
    : body.guestComposition

  const derivedFromComp =
    mergedGuestComposition &&
    typeof mergedGuestComposition.adults === "number" &&
    typeof mergedGuestComposition.children === "number"
      ? mergedGuestComposition.adults + mergedGuestComposition.children
      : undefined
  const partySize = updates.partySize ?? derivedFromComp ?? body.partySize

  return {
    startDate: updates.startDate ?? body.startDate,
    endDate: updates.endDate ?? body.endDate,
    partySize,
    guestComposition: mergedGuestComposition,
    travelPurpose: updates.travelPurpose ?? body.travelPurpose,
    roomAllocation: updates.roomAllocation ?? body.roomAllocation,
  }
}

function validateProfileTurn(
  result: ProfileTurnT,
  body: RequestBody,
): { result: ProfileTurnT; overridden: ProfileValidatorOverride | null } {
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

  const merged = buildMergedProfileState(updates, body)
  const missing = firstMissingField(merged)

  // --- Check 2: if decision is "ready", every required field must be set ---
  if (result.decision === "ready") {
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

  // --- Check 3: if decision is "ask_next", ask the actual next missing field ---
  //
  // Smaller/faster models can correctly extract profileUpdates while still
  // hallucinating stale "missing" fields in speech (e.g. asking for dates
  // when body.startDate/endDate are already set). The client state + this
  // turn's updates are authoritative enough to choose the next required
  // question deterministically.
  if (result.decision === "ask_next") {
    console.log("[VALIDATOR] ask_next check", JSON.stringify({
      merged,
      missing,
      llmSpeech: result.speech,
    }))

    if (missing === null) {
      return {
        result: {
          reasoning: result.reasoning,
          profileUpdates: updates,
          decision: "ready",
          speech: "Wonderful - I have your stay details. Would you like to stop by the virtual lounge first, or go straight to the hotel?",
        },
        overridden: "ask_next_complete",
      }
    }

    const expectedSpeech = CANNED_SPEECH[missing]
    if (stripPreamble(result.speech) !== expectedSpeech) {
      return {
        result: {
          reasoning: result.reasoning,
          profileUpdates: updates,
          decision: "ask_next",
          speech: expectedSpeech,
        },
        overridden: "ask_next_mismatch",
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

type AnthropicTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function toAnthropicTool(tool: OpenAITool): AnthropicTool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }
}

const PROFILE_TURN_TOOL: OpenAITool = {
  type: "function" as const,
  function: {
    name: "profile_turn",
    description:
      "Extract profile fields from the transcript, decide the next profile step, and produce short speech.",
    parameters: {
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          description:
            "Optional brief diagnostic. Omit unless needed.",
        },
        profileUpdates: {
          type: "object",
          description: "Only fields confidently stated by the guest.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            partySize: { type: "number" },
            guestComposition: {
              type: "object",
              description: "Partial updates allowed; server merges with prior state.",
              properties: {
                adults: { type: "number" },
                children: { type: "number" },
                childrenAges: {
                  type: "array",
                  items: { type: "number" },
                },
              },
            },
            travelPurpose: { type: "string" },
            roomAllocation: {
              type: "array",
              items: { type: "number" },
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
      required: ["decision", "speech"],
    },
  },
}

const PROFILE_COLLECTION_SKIP_INTENTS = [
  "ROOMS",
  "AMENITIES",
  "AMENITY_BY_NAME",
  "LOCATION",
  "HOTEL_EXPLORE",
  "TRAVEL_TO_HOTEL",
  "BOOK",
  "AFFIRMATIVE",
] as const

function buildProfileCollectionTools(): OpenAITool[] {
  return [
    PROFILE_TURN_TOOL,
    {
      type: "function" as const,
      function: {
        name: "navigate_and_speak",
        description: "Use only for explicit skip-ahead requests during profile collection.",
        parameters: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              enum: PROFILE_COLLECTION_SKIP_INTENTS,
            },
            amenityName: {
              type: "string",
              description: "Canonical name when intent is AMENITY_BY_NAME.",
            },
            speech: {
              type: "string",
              description: "Brief spoken acknowledgement.",
            },
          },
          required: ["intent", "speech"],
        },
      },
    },
  ]
}

function buildTools() {
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
            lightingMode: {
              type: "string",
              enum: ["daylight", "sunset", "night"],
              description: "Required when intent is LIGHTING_SET. Map evocative phrases: 'morning light', 'brighter' → daylight; 'golden hour', 'dusk', 'romantic/moody' → sunset; 'after dark', 'starlight' → night.",
            },
            category: {
              type: "string",
              description: "Required when intent is LOCATE_INTEREST_POINTS. A short Places-API-friendly query for what the guest wants nearby — e.g. 'kitesurfing locations', 'romantic restaurants', 'art galleries', 'hiking trails'. Normalize colloquial phrasing into something the Places API can search.",
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

  tools.push({
    type: "function" as const,
    function: {
      name: "no_action_speak",
      description: "No navigation action — just generate a helpful spoken response",
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
// Experiment: action-dispatch tool list. Only exposed when the request is
// gated for AMENITY_VIEWING + experiment === "action-dispatch". The prompt's
// amenityViewingBlock (experiment branch) instructs the model on how to pick
// among these. See plan `inherited-beaming-gray.md`.
//
// Schema-scale test: padding tools (~14) are appended below to measure
// latency + accuracy degradation when the model has to choose from ~17 tools
// instead of 3. The padding tools are NOT appropriate for the AMENITY_VIEWING
// `book` surface — selecting one is a false positive. Some (change_lighting,
// return_to_virtual_lounge) ARE legitimate picks for unrelated utterances
// that may slip through the client-side `\bbook\b` gate.
// ---------------------------------------------------------------------------

// Per-padding-tool descriptions surfaced both in the tool builder (for the
// LLM to see) and in the prompt block (for the LLM to know they exist). Kept
// in one place so the two stay in sync.
const PADDING_TOOL_DESCRIPTIONS: Record<PaddingToolName, string> = {
  travel_to_hotel: "Transition the guest from the virtual lounge into the hotel. Only legal from VIRTUAL_LOUNGE.",
  return_to_virtual_lounge: "Take the guest from the hotel back out to the virtual lounge. The system will then ask them to confirm.",
  show_hotel_overview: "Reset the camera to the hotel-wide overview. Used when the guest wants to step back from a detail.",
  list_amenities: "Speak a data-grounded list of the property's amenities. (System replaces your text with a canonical listing — keep your `text` short.)",
  step_into_unit: "Enter the interior view of the currently selected unit. Only legal from ROOM_SELECTED.",
  step_out_of_unit: "Switch to the exterior view of the currently selected unit. Only legal from ROOM_SELECTED.",
  back_to_rooms_panel: "From a selected unit's view, return to the rooms grid (or step back to interior if currently in exterior view).",
  open_booking_url: "Open the external booking page for the currently selected room. Only legal when a unit is selected.",
  change_lighting: "Change the property's lighting mode (daylight / sunset / night).",
  locate_interest_points: "Drop nearby points-of-interest of a given category on the map (restaurants, hiking, etc.). Only legal from HOTEL_EXPLORATION.",
  open_map: "Show the location/map panel for the property.",
  confirm_end_experience: "Signal that the guest wants to end the experience. The reducer escalates to END_CONFIRMING and asks the guest to confirm.",
  end_experience_affirm: "From END_CONFIRMING — the guest confirmed they want to end the experience. Use when the guest just said yes after the avatar asked for confirmation.",
  end_experience_cancel: "From END_CONFIRMING — the guest changed their mind and wants to stay. Use when the guest just said no after the avatar asked for confirmation.",
  lounge_return_affirm: "From LOUNGE_CONFIRMING — the guest confirmed they want to return to the virtual lounge.",
  lounge_return_cancel: "From LOUNGE_CONFIRMING — the guest decided to stay in the hotel.",
  explore_lounge_action: "From VIRTUAL_LOUNGE.asking — the guest agreed to explore the lounge first (before entering the hotel). Use when the guest said yes / sure to the avatar's offer of exploring the lounge.",
  select_hotel: "Pick a hotel from the destination grid. Only legal from DESTINATION_SELECT.",
  download_user_data: "Trigger a user-data download. Admin/dev command, rarely invoked by guests.",
}

const PADDING_PARAMETER_SCHEMAS: Record<PaddingToolName, Record<string, unknown>> = {
  travel_to_hotel: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  return_to_virtual_lounge: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  show_hotel_overview: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  list_amenities: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  step_into_unit: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  step_out_of_unit: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  back_to_rooms_panel: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  open_booking_url: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  change_lighting: {
    mode: { type: "string", enum: ["daylight", "sunset", "night"], description: "Lighting mode to switch to." },
    text: { type: "string", description: "Ava's spoken response (1-2 sentences)." },
  },
  locate_interest_points: {
    category: { type: "string", description: "Places-API query (e.g. 'romantic restaurants', 'hiking trails')." },
    text: { type: "string", description: "Ava's spoken response (1-2 sentences)." },
  },
  open_map: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  confirm_end_experience: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
  end_experience_affirm: { text: { type: "string", description: "Ava's spoken farewell (1-2 sentences)." } },
  end_experience_cancel: { text: { type: "string", description: "Ava's spoken response acknowledging the guest decided to stay (1-2 sentences)." } },
  lounge_return_affirm: { text: { type: "string", description: "Ava's spoken response confirming the lounge return (1-2 sentences)." } },
  lounge_return_cancel: { text: { type: "string", description: "Ava's spoken response acknowledging the guest will stay in the hotel (1-2 sentences)." } },
  explore_lounge_action: { text: { type: "string", description: "Ava's spoken response welcoming the guest into the lounge (1-2 sentences)." } },
  select_hotel: {
    hotelSlug: { type: "string", description: "Slug of the hotel to select from the destination grid." },
    text: { type: "string", description: "Ava's spoken response (1-2 sentences)." },
  },
  download_user_data: { text: { type: "string", description: "Ava's spoken response (1-2 sentences)." } },
}

const PADDING_REQUIRED_FIELDS: Record<PaddingToolName, string[]> = {
  travel_to_hotel: ["text"],
  return_to_virtual_lounge: ["text"],
  show_hotel_overview: ["text"],
  list_amenities: ["text"],
  step_into_unit: ["text"],
  step_out_of_unit: ["text"],
  back_to_rooms_panel: ["text"],
  open_booking_url: ["text"],
  change_lighting: ["mode", "text"],
  locate_interest_points: ["category", "text"],
  open_map: ["text"],
  confirm_end_experience: ["text"],
  end_experience_affirm: ["text"],
  end_experience_cancel: ["text"],
  lounge_return_affirm: ["text"],
  lounge_return_cancel: ["text"],
  explore_lounge_action: ["text"],
  select_hotel: ["hotelSlug", "text"],
  download_user_data: ["text"],
}

// ---------------------------------------------------------------------------
// Per-stage legal-tool sets. The action-dispatch surface filters the full
// action union down to the subset that makes sense for each stage so the LLM
// doesn't have to reason against the whole 22-tool list every turn.
//
// AMENITY_VIEWING keeps the full Phase 1a surface plus the new hotel-content
// actions (the `?fullActionDispatch=1` flag broadens the gate so every
// utterance — not just `\bbook\b` ones — lands here). The always-on Phase 1a
// `book` regex path still hits this branch with the same legal set.
// ---------------------------------------------------------------------------
type ExperimentToolName =
  | "navigate_to_amenity_action"
  | "open_rooms_panel_action"
  | "speak_only_action"
  | PaddingToolName

const STAGE_LEGAL_TOOLS: Record<string, ReadonlySet<ExperimentToolName>> = {
  HOTEL_EXPLORATION: new Set<ExperimentToolName>([
    "navigate_to_amenity_action",
    "open_rooms_panel_action",
    "speak_only_action",
    "show_hotel_overview",
    "list_amenities",
    "open_map",
    "locate_interest_points",
    "change_lighting",
    "return_to_virtual_lounge",
    "confirm_end_experience",
    "download_user_data",
  ]),
  AMENITY_VIEWING: new Set<ExperimentToolName>([
    "navigate_to_amenity_action",
    "open_rooms_panel_action",
    "speak_only_action",
    "show_hotel_overview",
    "list_amenities",
    "change_lighting",
    "return_to_virtual_lounge",
    "confirm_end_experience",
    "download_user_data",
  ]),
  ROOM_SELECTED: new Set<ExperimentToolName>([
    "speak_only_action",
    "step_into_unit",
    "step_out_of_unit",
    "back_to_rooms_panel",
    "open_booking_url",
    "change_lighting",
    "open_rooms_panel_action",
    "show_hotel_overview",
    "return_to_virtual_lounge",
    "confirm_end_experience",
    "download_user_data",
  ]),
  VIRTUAL_LOUNGE: new Set<ExperimentToolName>([
    "travel_to_hotel",
    "explore_lounge_action",
    "speak_only_action",
    "navigate_to_amenity_action",
    "open_rooms_panel_action",
    "open_map",
    "show_hotel_overview",
    "confirm_end_experience",
    "download_user_data",
  ]),
  DESTINATION_SELECT: new Set<ExperimentToolName>([
    "select_hotel",
    "speak_only_action",
    "confirm_end_experience",
    "download_user_data",
  ]),
  END_CONFIRMING: new Set<ExperimentToolName>([
    "end_experience_affirm",
    "end_experience_cancel",
    "speak_only_action",
  ]),
  LOUNGE_CONFIRMING: new Set<ExperimentToolName>([
    "lounge_return_affirm",
    "lounge_return_cancel",
    "speak_only_action",
  ]),
}

const MIGRATED_STAGES_FOR_EXPERIMENT: ReadonlySet<string> = new Set(
  Object.keys(STAGE_LEGAL_TOOLS),
)

const CORE_EXPERIMENT_TOOLS: Record<
  "navigate_to_amenity_action" | "open_rooms_panel_action" | "speak_only_action",
  OpenAITool
> = {
  navigate_to_amenity_action: {
    type: "function" as const,
    function: {
      name: "navigate_to_amenity_action",
      description:
        "Leave the current scene and navigate the guest to a specific amenity space. Requires a valid amenityId from the Active amenities list provided in the prompt.",
      parameters: {
        type: "object",
        properties: {
          amenityId: {
            type: "string",
            description:
              "The id of the target amenity. Must match exactly one of the ids in the Active amenities list.",
          },
          text: {
            type: "string",
            description:
              "Ava's spoken response: 1-2 natural sentences acknowledging the navigation, naming the destination.",
          },
        },
        required: ["amenityId", "text"],
      },
    },
  },
  open_rooms_panel_action: {
    type: "function" as const,
    function: {
      name: "open_rooms_panel_action",
      description:
        "Open the hotel rooms panel so the guest can browse overnight accommodation. Use only when the request is clearly about sleeping rooms / suites, not about the amenity space the guest is currently inside.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Ava's spoken response: 1-2 natural sentences acknowledging that you're bringing up the rooms.",
          },
        },
        required: ["text"],
      },
    },
  },
  speak_only_action: {
    type: "function" as const,
    function: {
      name: "speak_only_action",
      description:
        "Speak without changing scenes. Use to clarify ambiguous requests, describe the current scene, answer factual property questions, or hold the turn when the guest's utterance doesn't match any other tool.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Ava's spoken response: 1-2 natural sentences. Clarifying questions should be specific and offer a useful next step.",
          },
        },
        required: ["text"],
      },
    },
  },
}

function buildActionDispatchToolsForStage(stage: string): OpenAITool[] {
  const allowed = STAGE_LEGAL_TOOLS[stage]
  if (!allowed) return []

  const tools: OpenAITool[] = []
  // Core tools first (preserves Phase 1a's tool ordering for AMENITY_VIEWING).
  for (const name of ["navigate_to_amenity_action", "open_rooms_panel_action", "speak_only_action"] as const) {
    if (allowed.has(name)) tools.push(CORE_EXPERIMENT_TOOLS[name])
  }
  // Remaining tools — defined in PADDING_TOOL_NAMES order so the schema layout
  // is stable across stages.
  for (const name of PADDING_TOOL_NAMES) {
    if (allowed.has(name)) {
      tools.push({
        type: "function" as const,
        function: {
          name,
          description: PADDING_TOOL_DESCRIPTIONS[name],
          parameters: {
            type: "object",
            properties: PADDING_PARAMETER_SCHEMAS[name],
            required: PADDING_REQUIRED_FIELDS[name],
          },
        },
      })
    }
  }
  return tools
}

// ---------------------------------------------------------------------------
// TurnDecision builder
//
// Normalizes whichever tool fired into the authoritative wire shape the
// client dispatches against. Kept server-side so the wire format is owned
// by the route and clients don't have to re-derive it.
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
  | { type: "USER_INTENT"; intent: string; amenityName?: string; lightingMode?: "daylight" | "sunset" | "night"; params?: Record<string, unknown> }
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
  /**
   * Phase 9: mid-conversation profile corrections can ride on any tool's
   * response. Top-level field so callers apply it uniformly regardless of
   * which action type fired. Identical shape to profile_turn.profileUpdates.
   */
  profileUpdates?: Record<string, unknown>
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
  validatorOverride: ProfileValidatorOverride | null
}): TurnDecisionWire {
  const { functionName, result, speech, validatorOverride } = args
  const reasoning = typeof result.reasoning === "string" ? result.reasoning : undefined
  const reasoningAnnotated = validatorOverride
    ? `${reasoning ? `${reasoning} | ` : ""}validator_override=${validatorOverride}`
    : reasoning

  // Phase 9: any tool can carry mid-conversation profileUpdates. Extract once
  // and surface as a top-level envelope field when non-empty.
  const envelopeProfileUpdates =
    result.profileUpdates &&
    typeof result.profileUpdates === "object" &&
    Object.keys(result.profileUpdates as Record<string, unknown>).length > 0
      ? (result.profileUpdates as Record<string, unknown>)
      : undefined
  const profileUpdatesSuffix = envelopeProfileUpdates
    ? { profileUpdates: envelopeProfileUpdates }
    : {}

  if (functionName === "navigate_and_speak") {
    const intent = typeof result.intent === "string" ? result.intent : "UNKNOWN"
    const amenityName =
      typeof result.amenityName === "string" ? result.amenityName : undefined
    const lightingMode =
      result.lightingMode === "daylight" || result.lightingMode === "sunset" || result.lightingMode === "night"
        ? (result.lightingMode as "daylight" | "sunset" | "night")
        : undefined
    const category =
      typeof result.category === "string" && result.category.trim().length > 0
        ? result.category.trim()
        : undefined
    const params: Record<string, unknown> | undefined =
      amenityName || lightingMode || category
        ? {
            ...(amenityName ? { amenityName } : {}),
            ...(lightingMode ? { lightingMode } : {}),
            ...(category ? { category } : {}),
          }
        : undefined
    const proposal = proposalForIntent(intent, amenityName)
    const action: TurnDecisionActionWire = {
      type: "USER_INTENT",
      intent,
      ...(amenityName ? { amenityName } : {}),
      ...(lightingMode ? { lightingMode } : {}),
      ...(params ? { params } : {}),
    }
    return {
      action,
      speech,
      ...(reasoningAnnotated ? { reasoning: reasoningAnnotated } : {}),
      ...(proposal ? { proposal } : {}),
      ...profileUpdatesSuffix,
    }
  }

  if (functionName === "profile_turn") {
    const decisionVal = result.decision
    const decision: "ask_next" | "clarify" | "ready" =
      decisionVal === "ask_next" || decisionVal === "clarify" || decisionVal === "ready"
        ? decisionVal
        : "ask_next"
    return {
      action: {
        type: "PROFILE_TURN_RESULT",
        decision,
        ...(envelopeProfileUpdates ? { profileUpdates: envelopeProfileUpdates } : {}),
      },
      speech,
      ...(reasoningAnnotated ? { reasoning: reasoningAnnotated } : {}),
      ...profileUpdatesSuffix,
    }
  }

  // no_action_speak, or anything else (validator override / fallback) —
  // represent as NO_ACTION with reasoning annotated so the client can see why.
  return {
    action: { type: "NO_ACTION" },
    speech,
    ...(reasoningAnnotated ? { reasoning: reasoningAnnotated } : {}),
    ...profileUpdatesSuffix,
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const openaiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY ?? process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY

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

    const isProfileCollection = body.journeyContext.stage === "PROFILE_COLLECTION"
    if (isProfileCollection && !anthropicKey) {
      return new Response(
        JSON.stringify({ error: "Anthropic orchestration not configured", code: "ANTHROPIC_NOT_CONFIGURED" }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      )
    }
    if (!isProfileCollection && !openaiKey) {
      return new Response(
        JSON.stringify({ error: "Orchestration not configured", code: "NOT_CONFIGURED" }),
        { status: 501, headers: { "Content-Type": "application/json" } },
      )
    }

    // Phase 4: reconstruct profile from client body + transcript before
    // building the prompt. Logged at the bottom of the handler so we can
    // diagnose when transcript disagrees with client body.
    const reconstructedProfile = reconstructProfileFromTranscript(
      body.conversationHistory,
      body,
    )
    const systemPrompt = buildSystemPrompt(body, reconstructedProfile)
    // PROFILE_COLLECTION's primary tool is profile_turn (extraction + ask_next /
    // clarify / ready). navigate_and_speak is also exposed so the model can
    // honor explicit skip-ahead requests ("show me the rooms / amenities /
    // hotel / surrounding area"); the prompt's "Skip-ahead exception" block
    // governs when to pick which. Room-plan changes are handled by the
    // dedicated client-side planner (/api/room-planner), not this route.
    // Experiment: when `experiment === "action-dispatch"` AND stage is in the
    // migrated set (HOTEL_EXPLORATION / AMENITY_VIEWING / ROOM_SELECTED /
    // VIRTUAL_LOUNGE / DESTINATION_SELECT / END_CONFIRMING / LOUNGE_CONFIRMING),
    // swap in the per-stage action tool subset and tell the model it MUST pick
    // one ("required" tool_choice). Phase 1a's always-on `\bbook\b` surface in
    // AMENITY_VIEWING is preserved (client sends `experiment: "action-dispatch"`
    // for that case unchanged); the new `?fullActionDispatch=1` URL flag
    // broadens the client-side gate to every utterance in every migrated stage.
    const isActionDispatchExperiment =
      body.experiment === "action-dispatch" &&
      MIGRATED_STAGES_FOR_EXPERIMENT.has(body.journeyContext.stage)
    const tools = isActionDispatchExperiment
      ? buildActionDispatchToolsForStage(body.journeyContext.stage)
      : isProfileCollection
        ? buildProfileCollectionTools()
        : buildTools()
    const toolChoice = isActionDispatchExperiment
      ? ("required" as const)
      : ("auto" as const)

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

    // Per-segment server timings stitched into the response so the per-session
    // latency log file can attribute time to pre-LLM, LLM, and post-LLM. All
    // Date.now ms; null fields are set just below as we cross each boundary.
    let llmCallStart: number | null = null
    let llmCallEnd: number | null = null

    try {
      if (isProfileCollection) {
        llmCallStart = Date.now()
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey!,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 360,
            temperature: 0.2,
            system: systemPrompt,
            messages: [
              { role: "user", content: `User message: "${body.message}"${journeyBlock}` },
            ],
            tools: tools.map(toAnthropicTool),
            tool_choice: { type: "any" },
          }),
          signal: controller.signal,
        })

        clearTimeout(timeout)
        llmCallEnd = Date.now()

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          console.error("Anthropic API error:", errorData)
          return new Response(
            JSON.stringify({ error: "Failed to orchestrate" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          )
        }

        const data = await response.json()
        const toolCall = data.content?.find((block: { type?: string }) => block.type === "tool_use")
        const functionName = toolCall?.name
        const args = toolCall?.input

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

        const validated = schema.safeParse(args)

        if (!validated.success) {
          console.error("Schema validation failed:", validated.error)
          return new Response(
            JSON.stringify({ error: "Invalid orchestration structure" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          )
        }

        let result = validated.data as Record<string, unknown>
        let validatorOverride: ProfileValidatorOverride | null = null

        if (functionName === "profile_turn") {
          const check = validateProfileTurn(result as unknown as ProfileTurnT, body)
          result = check.result as unknown as Record<string, unknown>
          validatorOverride = check.overridden
        }

        const responseBody: Record<string, unknown> = { tool: functionName }
        const isReadyHandoff =
          (functionName === "profile_turn" && result.decision === "ready") ||
          (functionName === "navigate_and_speak" && result.intent === "TRAVEL_TO_HOTEL")
        const shouldStripPreamble = !isReadyHandoff
        const cleanSpeech = (s: unknown) =>
          shouldStripPreamble && typeof s === "string" ? stripPreamble(s) : s

        const passThroughProfileUpdates = (): void => {
          if (
            result.profileUpdates &&
            typeof result.profileUpdates === "object" &&
            Object.keys(result.profileUpdates).length > 0
          ) {
            responseBody.profileUpdates = result.profileUpdates
          }
        }

        if (functionName === "navigate_and_speak") {
          responseBody.intent = result.intent
          if (result.amenityName) responseBody.amenityName = result.amenityName
          if (result.lightingMode) responseBody.lightingMode = result.lightingMode
          responseBody.speech = cleanSpeech(result.speech)
          passThroughProfileUpdates()
        } else if (functionName === "profile_turn") {
          responseBody.reasoning = result.reasoning
          responseBody.profileUpdates = result.profileUpdates ?? {}
          responseBody.decision = result.decision
          responseBody.speech = cleanSpeech(result.speech)
        } else {
          responseBody.speech = cleanSpeech(result.speech)
          passThroughProfileUpdates()
        }

        const finalSpeechText =
          typeof responseBody.speech === "string" ? responseBody.speech : ""
        const decision = buildTurnDecision({
          functionName,
          result,
          speech: finalSpeechText,
          validatorOverride,
        })
        responseBody.decision_envelope = decision

        const responseSent = Date.now()
        // Latency log: per-segment server timings echoed to the client so the
        // per-session log file can split network vs server vs LLM time.
        responseBody.serverTimings = {
          requestReceived: requestStart,
          llmCallStart,
          llmCallEnd,
          responseSent,
          provider: "anthropic",
          model: "claude-haiku-4-5",
        }
        if (body.turnId) responseBody.turnId = body.turnId

        console.log("[ORCHESTRATE]", JSON.stringify({
          turnId: body.turnId ?? null,
          stage: body.journeyContext.stage,
          awaiting: body.profileAwaiting,
          provider: "anthropic",
          model: "claude-haiku-4-5",
          tool: functionName,
          toolCalled: functionName,
          latencyMs: responseSent - requestStart,
          llmMs: llmCallStart !== null && llmCallEnd !== null ? llmCallEnd - llmCallStart : null,
          reasoning: result.reasoning,
          decision: result.decision,
          profileUpdates: result.profileUpdates,
          validatorOverride,
          rawSpeech: result.speech,
          stripped: shouldStripPreamble,
          outSpeech: responseBody.speech,
          decisionAction: (decision as { action?: { type?: string } | null })?.action?.type ?? null,
          reconstructedProfile,
          historyLen: body.conversationHistory?.length ?? 0,
        }))

        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      llmCallStart = Date.now()
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Latency batch (post-Day-1): swapped from gpt-4o / gpt-4o-mini to
          // the gpt-5.4 family for ~3-5x faster output. PROFILE_COLLECTION
          // (multi-constraint extraction with the validator backstop) gets
          // gpt-5.4-mini; everything else gets gpt-5.4-nano. Watch the
          // `validatorOverride` rate in the [ORCHESTRATE] log lines — if PC
          // overrides spike past ~30% of turns, fall back to "gpt-4o" for PC.
          // History note: gpt-4o-mini previously failed PC by looping
          // ask_next/ready with empty profileUpdates; that's why PC was on
          // gpt-4o. gpt-5.4-mini is a newer-generation model and should
          // handle the structured extraction reliably.
          model: "gpt-5.4-nano",
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
      llmCallEnd = Date.now()

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

      // Build response
      let result = validated.data as Record<string, unknown>
      let validatorOverride: ProfileValidatorOverride | null = null

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

      // Phase 9: mid-conversation profile corrections surface on the 3
      // non-profile tools via an optional `profileUpdates` field. Pass it
      // through to the client whenever present so the correction is applied
      // with the same idempotent write path as profile_turn.
      const passThroughProfileUpdates = (): void => {
        if (
          result.profileUpdates &&
          typeof result.profileUpdates === "object" &&
          Object.keys(result.profileUpdates).length > 0
        ) {
          responseBody.profileUpdates = result.profileUpdates
        }
      }

      if (functionName === "navigate_and_speak") {
        responseBody.intent = result.intent
        if (result.amenityName) responseBody.amenityName = result.amenityName
        if (result.lightingMode) responseBody.lightingMode = result.lightingMode
        if (result.category) responseBody.category = result.category
        responseBody.speech = cleanSpeech(result.speech)
        passThroughProfileUpdates()
      } else if (functionName === "profile_turn") {
        responseBody.reasoning = result.reasoning
        responseBody.profileUpdates = result.profileUpdates ?? {}
        responseBody.decision = result.decision
        responseBody.speech = cleanSpeech(result.speech)
      } else if (
        functionName === "navigate_to_amenity_action" ||
        functionName === "open_rooms_panel_action" ||
        functionName === "speak_only_action"
      ) {
        // Primary action-dispatch tools. The `text` field carries Ava's
        // speech (renamed from `speech` to make the action shape distinct
        // from legacy tools). Surface as `speech` on the wire so client-side
        // latency / log code doesn't need a special case. The client
        // branches directly on `responseBody.tool` for these.
        responseBody.speech = result.text
        if (functionName === "navigate_to_amenity_action") {
          responseBody.amenityId = result.amenityId
        }
      } else if ((PADDING_TOOL_NAMES as readonly string[]).includes(functionName)) {
        // Full action-dispatch surface (former padding tools + new
        // affirm/cancel/explore actions). All carry `text`; some carry
        // additional args (mode for change_lighting, category for
        // locate_interest_points, hotelSlug for select_hotel). Marshal
        // them onto the wire uniformly; client switches on `responseBody.tool`.
        responseBody.speech = result.text
        if (typeof result.mode === "string") responseBody.lightingMode = result.mode
        if (typeof result.category === "string") responseBody.category = result.category
        if (typeof result.hotelSlug === "string") responseBody.hotelSlug = result.hotelSlug
      } else {
        // no_action_speak
        responseBody.speech = cleanSpeech(result.speech)
        passThroughProfileUpdates()
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

      const responseSent = Date.now()
      // Latency log: per-segment server timings echoed to the client so the
      // per-session log file can split network vs server vs LLM time.
      responseBody.serverTimings = {
        requestReceived: requestStart,
        llmCallStart,
        llmCallEnd,
        responseSent,
        provider: "openai",
        model: "gpt-5.4-nano",
      }
      if (body.turnId) responseBody.turnId = body.turnId

      console.log("[ORCHESTRATE]", JSON.stringify({
        turnId: body.turnId ?? null,
        stage: body.journeyContext.stage,
        awaiting: body.profileAwaiting,
        tool: functionName,
        toolCalled: functionName,
        latencyMs: responseSent - requestStart,
        llmMs: llmCallStart !== null && llmCallEnd !== null ? llmCallEnd - llmCallStart : null,
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
