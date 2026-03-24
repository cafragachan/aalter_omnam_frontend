// ---------------------------------------------------------------------------
// Intent Classifier — single source of truth for user intent detection
// ---------------------------------------------------------------------------
// All regex patterns from the old JourneyOrchestrator consolidated here.
// Pure function, no React dependency — easy to unit test and swap for AI NLU.
// ---------------------------------------------------------------------------

export type UserIntent =
  | { type: "ROOMS" }
  | { type: "AMENITIES" }
  | { type: "AMENITY_BY_NAME"; amenityName: string }
  | { type: "LOCATION" }
  | { type: "INTERIOR" }
  | { type: "EXTERIOR" }
  | { type: "BACK" }
  | { type: "HOTEL_EXPLORE" }
  | { type: "DOWNLOAD_DATA" }
  | { type: "BOOK" }
  | { type: "AFFIRMATIVE" }
  | { type: "NEGATIVE" }
  | { type: "TRAVEL_TO_HOTEL" }
  | { type: "OTHER_OPTIONS" }
  | { type: "ROOM_TOGETHER" }
  | { type: "ROOM_SEPARATE" }
  | { type: "ROOM_AUTO" }
  | { type: "ROOM_PLAN_CHEAPER" }
  | { type: "ROOM_PLAN_COMPACT" }
  | { type: "UNKNOWN" }

const DOWNLOAD_DATA_RE = /\bdownload\s+user\s+data\b/
const TRAVEL_TO_HOTEL_RE = /\b(take me to the hotel|go to the hotel|head to the hotel|travel to the hotel|let'?s go to the hotel|ready to go|let'?s travel|bring me to the hotel|hotel please|straight to the hotel|head over)\b/i
const AFFIRMATIVE_RE = /\b(yes|yeah|sure|absolutely|definitely|love to|why not|let'?s do it|sounds good|okay|ok|of course|i'?d love|please|certainly|yep|yea)\b/i
const NEGATIVE_RE = /\b(no|nah|skip|not really|no thanks|no thank you|i'?m good|pass|nope|not interested)\b/i
const ROOM_RE = /\b(room|rooms|suite|suites|stay|bed|accommodation)\b/
const BOOK_RE = /\b(book\s*(?:it|this|that|the\s+room|now)?|reserve|make\s+(?:a\s+)?reservation|proceed\s+(?:with\s+)?(?:booking|reservation)|let'?s\s+(?:book|reserve|do\s+it)|i(?:'d| would)\s+(?:like\s+to\s+)?(?:book|reserve)|i(?:'ll| will)\s+take\s+(?:it|this|that)|sign\s+me\s+up)\b/i
const AMENITY_RE = /\b(amenity|amenities|facility|facilities)\b/
const AMENITY_NAME_RE = /\b(lobby|conference|spa|restaurant|pool|gym|bar|lounge|dining)\b/
const LOCATION_RE = /\b(location|surrounding|surroundings|area|neighbou?rhood|outside|around|nearby|map|walk)\b/
const INTERIOR_RE = /\b(interior|inside|indoor|in)\b/
const EXTERIOR_RE = /\b(exterior|outside|outdoor|out|view)\b/
const BACK_RE = /\b(back|return|cancel|nevermind|never mind|go back)\b/
const OTHER_OPTIONS_RE = /\b(other\s+options|something\s+else|explore\s+(?:other|more)|see\s+(?:other|more)|different\s+option|alternatives|what\s+else|other\s+choices|more\s+options)\b/i
const ROOM_TOGETHER_RE = /\b(shar(?:e|ing)\s+rooms?|together|same\s+room|fewer\s+rooms?|all\s+together|one\s+(?:big\s+)?room|minimize\s+rooms?)\b/i
const ROOM_SEPARATE_RE = /\b(separate\s+rooms?|own\s+room|individual\s+rooms?|each\s+(?:their|our)\s+own|one\s+each|(?:a\s+)?room\s+each|private\s+rooms?|my\s+own\s+room)\b/i
const ROOM_AUTO_RE = /\b(you\s+decide|you\s+recommend|suggest(?:\s+(?:a|one|the))?|up\s+to\s+you|whatever\s+works|your\s+(?:call|choice|recommendation)|best\s+(?:option|layout)|recommend\s+(?:one|a layout))\b/i
const ROOM_PLAN_CHEAPER_RE = /\b(cheap(?:er|est)?|budget\s*(?:friend|conscious|option)|more\s+affordable|less\s+expensive|save\s+(?:money|cost)|lower\s+(?:price|cost)|economical|cut\s+cost|too\s+(?:much|expensive|pricey)|more\s+(?:economical|reasonable)|(?:can(?:'t|\s*not)\s+afford)|tighten|(?:reduce|lower|bring\s+down)\s+(?:the\s+)?(?:price|cost|total))\b/i
const ROOM_PLAN_COMPACT_RE = /\b(fewer\s+rooms?|less\s+rooms?|(?:pack|fit)\s+(?:us\s+)?(?:in|together)|combine|share\s+more|(?:reduce|minimize|cut)\s+(?:the\s+)?(?:number\s+of\s+)?rooms?|not\s+(?:that\s+)?many\s+rooms?)\b/i
const HOTEL_EXPLORE_RE =
  /(?:\b(explore|tour|see|show|walk around|look around|view)\b.*\bhotel\b|\bhotel\b.*\b(explore|tour|see|show|walk around|look around|view)\b|\bhotel view\b)/

/**
 * Classify a user utterance into a navigation / action intent.
 *
 * Priority order (highest → lowest):
 *   DOWNLOAD_DATA > BACK > TRAVEL_TO_HOTEL > BOOK > INTERIOR / EXTERIOR >
 *   HOTEL_EXPLORE > AMENITY_BY_NAME > AMENITIES (generic) > ROOMS / LOCATION >
 *   OTHER_OPTIONS > AFFIRMATIVE / NEGATIVE
 */
// ---------------------------------------------------------------------------
// Avatar Proposal Classifier — detect what the avatar is proposing to the user
// ---------------------------------------------------------------------------
// Runs on avatar transcriptions so that a bare "yes" from the user can be
// resolved against what the avatar last asked about.
// ---------------------------------------------------------------------------

export type AvatarProposal = {
  proposal: "rooms" | "amenities" | "location" | "book" | "interior_or_exterior"
  amenityName?: string
}

const PROPOSAL_BOOK_RE = /\b(book|reserv|proceed with booking)\b/
const PROPOSAL_QUESTION_RE = /\b(would you|shall|like to|ready to|prefer|want to)\b/
const PROPOSAL_VIEW_RE = /\b(interior|exterior|inside|outside|step inside|view from)\b/
const PROPOSAL_ROOM_RE = /\b(rooms?|suite|accommodation)\b/
const PROPOSAL_ROOM_ACTION_RE = /\b(would you|shall|like to|check out|show you|pull up|look at|see the)\b/
const PROPOSAL_AMENITY_NAME_RE = /\b(pool|spa|restaurant|lobby|conference|gym|bar|lounge|dining)\b/
const PROPOSAL_AMENITY_ACTION_RE = /\b(would you|shall|like to|show you|take you|head to|visit|see the|check out)\b/
const PROPOSAL_AMENITY_GENERIC_RE = /\b(ameniti|facilit)\b/
const PROPOSAL_LOCATION_RE = /\b(location|surrounding|area|neighbourhood|nearby)\b/

/**
 * Classify what the avatar is proposing to the user, so a bare "yes"
 * can be resolved contextually.
 *
 * Returns null if no recognizable proposal is detected (preserves existing state).
 *
 * Priority: BOOK > INTERIOR/EXTERIOR > ROOMS > SPECIFIC AMENITY > GENERIC AMENITY > LOCATION
 */
export function classifyAvatarProposal(message: string): AvatarProposal | null {
  const lower = message.toLowerCase()

  // Booking proposals
  if (PROPOSAL_BOOK_RE.test(lower) && PROPOSAL_QUESTION_RE.test(lower)) {
    return { proposal: "book" }
  }

  // Interior/exterior proposals
  if (PROPOSAL_VIEW_RE.test(lower) && PROPOSAL_QUESTION_RE.test(lower)) {
    return { proposal: "interior_or_exterior" }
  }

  // Room proposals
  if (PROPOSAL_ROOM_RE.test(lower) && PROPOSAL_ROOM_ACTION_RE.test(lower)) {
    return { proposal: "rooms" }
  }

  // Specific amenity proposals (e.g., "Would you like to see the pool?")
  const amenityMatch = lower.match(PROPOSAL_AMENITY_NAME_RE)
  if (amenityMatch && PROPOSAL_AMENITY_ACTION_RE.test(lower)) {
    return { proposal: "amenities", amenityName: amenityMatch[1] }
  }

  // Generic amenity proposals
  if (PROPOSAL_AMENITY_GENERIC_RE.test(lower) && PROPOSAL_AMENITY_ACTION_RE.test(lower)) {
    return { proposal: "amenities" }
  }

  // Location proposals
  if (PROPOSAL_LOCATION_RE.test(lower) && PROPOSAL_AMENITY_ACTION_RE.test(lower)) {
    return { proposal: "location" }
  }

  return null
}

// ---------------------------------------------------------------------------
// User Intent Classifier
// ---------------------------------------------------------------------------

export function classifyIntent(message: string): UserIntent {
  const lower = message.toLowerCase()

  // --- admin command: download user data ---
  if (DOWNLOAD_DATA_RE.test(lower)) return { type: "DOWNLOAD_DATA" }

  // --- highest priority: navigation commands ---
  if (BACK_RE.test(lower)) return { type: "BACK" }

  // --- travel to hotel (lounge → hotel transition) ---
  if (TRAVEL_TO_HOTEL_RE.test(lower)) return { type: "TRAVEL_TO_HOTEL" }

  // --- booking intent ---
  if (BOOK_RE.test(lower)) return { type: "BOOK" }

  // --- view commands (interior / exterior) ---
  const wantsInterior = INTERIOR_RE.test(lower)
  const wantsExterior = EXTERIOR_RE.test(lower)
  if (wantsInterior && !wantsExterior) return { type: "INTERIOR" }
  if (wantsExterior && !wantsInterior) return { type: "EXTERIOR" }

  // --- hotel-level explore ---
  if (HOTEL_EXPLORE_RE.test(lower)) return { type: "HOTEL_EXPLORE" }

  // --- specific amenity by name (e.g., "take me to the lobby") ---
  const amenityNameMatch = lower.match(AMENITY_NAME_RE)
  if (amenityNameMatch) {
    // If the user says a specific amenity name, navigate there directly
    // But if they also say the generic "amenities" word, treat as listing request
    if (!AMENITY_RE.test(lower)) {
      return { type: "AMENITY_BY_NAME", amenityName: amenityNameMatch[1] }
    }
  }

  // --- panel navigation (rooms / amenities / location) ---
  const wantsRooms = ROOM_RE.test(lower)
  const wantsAmenities = AMENITY_RE.test(lower)
  const wantsLocation = LOCATION_RE.test(lower)

  const count = [wantsRooms, wantsAmenities, wantsLocation].filter(Boolean).length
  if (count === 1) {
    if (wantsRooms) return { type: "ROOMS" }
    if (wantsAmenities) return { type: "AMENITIES" }
    if (wantsLocation) return { type: "LOCATION" }
  }

  // --- fallback: if only an amenity name was matched with no other intent ---
  if (amenityNameMatch) {
    return { type: "AMENITY_BY_NAME", amenityName: amenityNameMatch[1] }
  }

  // --- room plan adjustments (higher priority than distribution since they're more specific) ---
  if (ROOM_PLAN_CHEAPER_RE.test(lower)) return { type: "ROOM_PLAN_CHEAPER" }
  if (ROOM_PLAN_COMPACT_RE.test(lower)) return { type: "ROOM_PLAN_COMPACT" }

  // --- room distribution preferences ---
  if (ROOM_SEPARATE_RE.test(lower)) return { type: "ROOM_SEPARATE" }
  if (ROOM_TOGETHER_RE.test(lower)) return { type: "ROOM_TOGETHER" }
  if (ROOM_AUTO_RE.test(lower)) return { type: "ROOM_AUTO" }

  // --- "other options" / "something else" → context-dependent, resolved by journey machine ---
  if (OTHER_OPTIONS_RE.test(lower)) return { type: "OTHER_OPTIONS" }

  // --- affirmative / negative (low priority, mainly used by VIRTUAL_LOUNGE) ---
  if (AFFIRMATIVE_RE.test(lower)) return { type: "AFFIRMATIVE" }
  if (NEGATIVE_RE.test(lower)) return { type: "NEGATIVE" }

  return { type: "UNKNOWN" }
}
