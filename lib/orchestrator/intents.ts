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
  | { type: "RETURN_TO_LOUNGE" }
  | { type: "END_EXPERIENCE" }
  | { type: "UNKNOWN" }

// END_EXPERIENCE — multi-strategy detection:
//   1. Explicit farewells: goodbye, bye, farewell, see you later, etc.
//   2. [exit verb] + [session noun]: "end this session", "close the tour", "leave the experience"
//   3. [desire phrase] + [exit verb]: "I need to leave", "I want to go", "I have to head out"
//   4. Standalone closers: "that's all", "I'm done", "wrap up", "nothing else"
const END_FAREWELL_RE = /\b(goodbye|good\s*bye|farewell|bye\s*bye|bye|see\s+you\s+(?:later|soon|next\s+time|around)|have\s+a\s+(?:good|nice|great)\s+(?:day|night|evening|one)|take\s+care|until\s+next\s+time|good\s+night)\b/i
const END_EXIT_VERBS = `end|finish|close|stop|leave|exit|quit|terminate|conclude|wrap\\s*up|shut\\s*down|log\\s*(?:off|out)|sign\\s*(?:off|out)`
const END_SESSION_NOUNS = `session|experience|tour|visit|conversation|chat|call|demo|this`
const END_VERB_NOUN_RE = new RegExp(
  `\\b(${END_EXIT_VERBS})\\b.*\\b(${END_SESSION_NOUNS})\\b` +
  `|\\b(${END_SESSION_NOUNS})\\b.*\\b(${END_EXIT_VERBS})\\b`,
  "i",
)
const END_DESIRE_RE = new RegExp(
  `\\b(i\\s+(?:need|want|have|got|would\\s+like|'?d\\s+like)\\s+to|i\\s+(?:must|should|gotta)|let\\s+me|i'?m\\s+(?:going\\s+to|gonna))\\s+` +
  `(?:.*\\b)?(leave|go|head\\s+out|get\\s+going|take\\s+off|run|bounce|dip|step\\s+out|call\\s+it|end\\s+it|stop|sign\\s+off|log\\s+off)\\b`,
  "i",
)
const END_CLOSERS_RE = /\b(that'?s\s+all|i'?m\s+done|i'?m\s+finished|i'?m\s+good\s+for\s+(?:now|today)|nothing\s+(?:else|more)|no\s+more\s+questions|that\s+(?:was|is)\s+(?:everything|all\s+i\s+needed)|all\s+(?:good|set)|we'?re\s+done|thanks?\s+for\s+everything|thank\s+you\s+for\s+everything|i\s+think\s+(?:that'?s\s+it|we'?re\s+done|i'?m\s+done)|call\s+it\s+a\s+day)\b/i

function isEndExperience(text: string): boolean {
  return END_FAREWELL_RE.test(text)
    || END_VERB_NOUN_RE.test(text)
    || END_DESIRE_RE.test(text)
    || END_CLOSERS_RE.test(text)
}
const RETURN_TO_LOUNGE_RE = /\b(?:(?:go|take\s+me|head|travel|return|get)\s+(?:back\s+)?(?:to\s+)?(?:the\s+)?(?:virtual\s+)?(?:lounge|lobby|home\s*page|main\s*page|gallery)|back\s+to\s+(?:the\s+)?(?:virtual\s+)?(?:lounge|lobby|home\s*page|main\s*page|gallery))\b/i
const DOWNLOAD_DATA_RE = /\bdownload\s+user\s+data\b/
const TRAVEL_TO_HOTEL_RE = /\b(take me to the hotel|go to the hotel|head to the hotel|travel to the hotel|let'?s go to the hotel|ready to go|let'?s travel|bring me to the hotel|hotel please|straight to the hotel|head over)\b/i
const AFFIRMATIVE_RE = /\b(yes|yeah|sure|absolutely|definitely|love to|why not|let'?s do it|sounds good|okay|ok|of course|i'?d love|please|certainly|yep|yea)\b/i
const NEGATIVE_RE = /\b(no|nah|skip|not really|no thanks|no thank you|i'?m good|pass|nope|not interested)\b/i
const ROOM_RE = /\b(room|rooms|suite|suites|stay|bed|accommodation)\b/
const BOOK_RE = /\b(book\s*(?:it|this|that|the\s+room|now)?|reserve|make\s+(?:a\s+)?reservation|proceed\s+(?:with\s+)?(?:booking|reservation)|let'?s\s+(?:book|reserve|do\s+it)|i(?:'d| would)\s+(?:like\s+to\s+)?(?:book|reserve)|i(?:'ll| will)\s+take\s+(?:it|this|that)|sign\s+me\s+up)\b/i
const AMENITY_RE = /\b(amenity|amenities|facility|facilities)\b/
const AMENITY_NAME_RE = /\b(lobby|conference|spa|restaurant|pool|gym|bar|lounge|dining)\b/
const LOCATION_RE = /\b(location|surrounding|surroundings|area|neighbou?rhood|outside|around|nearby|map|walk)\b/
const INTERIOR_RE = /\b(interior|inside|indoor)\b/
const EXTERIOR_RE = /\b(exterior|outside|outdoor)\b/
const BACK_RE = /\b(go back|take me back|head back|back to|return to|cancel|nevermind|never mind|let'?s go back|bring me back)\b/i
const OTHER_OPTIONS_RE = /\b(other\s+options|something\s+else|explore\s+(?:other|more)|see\s+(?:other|more)|different\s+option|alternatives|what\s+else|other\s+choices|more\s+options)\b/i

// Question detection — if user is asking a question (not giving a navigation command),
// skip navigation keyword matching to avoid false triggers like "what's the room area?"
const QUESTION_RE = /(?:^|\b)(what|how|why|when|where|which|who|is there|are there|can i|can you|could you|tell me|do you|does it|does the|will there|would there)\b|[?]\s*$/i

// Navigation action verbs — when a question contains one of these,
// it's still a navigation request (e.g., "can you show me the rooms?")
const NAV_ACTION_RE = /\b(show|take me|go to|see the|let me see|let's see|bring me|head to|navigate|switch to|open|pull up|check out|look at|explore|visit|browse|move to|jump to)\b/i
const ROOM_TOGETHER_RE = /\b(shar(?:e|ing)\s+rooms?|together|same\s+room|fewer\s+rooms?|all\s+together|one\s+(?:big\s+)?room|minimize\s+rooms?)\b/i
const ROOM_SEPARATE_RE = /\b(separate\s+rooms?|own\s+room|individual\s+rooms?|each\s+(?:their|our)\s+own|one\s+each|(?:a\s+)?room\s+each|private\s+rooms?|my\s+own\s+room)\b/i
const ROOM_AUTO_RE = /\b(you\s+decide|you\s+recommend|suggest(?:\s+(?:a|one|the))?|up\s+to\s+you|whatever\s+works|your\s+(?:call|choice|recommendation)|best\s+(?:option|layout)|recommend\s+(?:one|a layout))\b/i
const ROOM_PLAN_CHEAPER_RE = /\b(cheap(?:er|est)?|budget\s*(?:friend|conscious|option)|more\s+affordable|less\s+expensive|save\s+(?:money|cost)|lower\s+(?:price|cost)|economical|cut\s+cost|too\s+(?:much|expensive|pricey)|more\s+(?:economical|reasonable)|(?:can(?:'t|\s*not)\s+afford)|tighten|(?:reduce|lower|bring\s+down)\s+(?:the\s+)?(?:price|cost|total))\b/i
const ROOM_PLAN_COMPACT_RE = /\b(fewer\s+rooms?|less\s+rooms?|(?:pack|fit)\s+(?:us\s+)?(?:in|together)|combine|share\s+more|(?:reduce|minimize|cut)\s+(?:the\s+)?(?:number\s+of\s+)?rooms?|not\s+(?:that\s+)?many\s+rooms?)\b/i
// Semantic groups for hotel overview / explore intent:
//   1. [action verb] + [place noun] (bidirectional) — "show me the hotel", "hotel, let me explore"
//   2. [perspective word] — inherently means overview: "bird's eye", "panoramic"
//   3. [spatial verb] — return to wide angle: "zoom out", "pull back"
//   4. [scope word] + [place/view noun] — "whole hotel", "full view", "entire property"
//   5. [place noun] + [view word] — "hotel view", "property overview"
const EXPLORE_ACTIONS = `explore|tour|see|show|walk\\s*around|look\\s*around|view|check\\s*out|take\\s*me\\s*(?:to|around)`
const PLACE_NOUNS = `hotel|property|building|resort`
const PERSPECTIVE_WORDS = `overview|bird'?s?\\s*eye|aerial|panoramic|panorama`
const SPATIAL_VERBS = `zoom\\s*out|pull\\s*back|step\\s*back|widen|pan\\s*out`
const SCOPE_WORDS = `whole|full|entire|overall|complete|general`
const HOTEL_EXPLORE_RE = new RegExp(
  `(?:` +
    `\\b(${EXPLORE_ACTIONS})\\b.*\\b(${PLACE_NOUNS})\\b` +
    `|\\b(${PLACE_NOUNS})\\b.*\\b(${EXPLORE_ACTIONS})\\b` +
    `|\\b(${PERSPECTIVE_WORDS})\\b` +
    `|\\b(${SPATIAL_VERBS})\\b` +
    `|\\b(${SCOPE_WORDS})\\s+(${PLACE_NOUNS}|view)\\b` +
    `|\\b(${PLACE_NOUNS})\\s+(view|overview)\\b` +
  `)`,
  "i",
)

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

  // --- end experience / farewell (high priority, before navigation) ---
  if (isEndExperience(lower)) return { type: "END_EXPERIENCE" }

  // --- return to virtual lounge (before BACK so "go back to the lounge" isn't swallowed) ---
  if (RETURN_TO_LOUNGE_RE.test(lower)) return { type: "RETURN_TO_LOUNGE" }

  // --- highest priority: navigation commands ---
  if (BACK_RE.test(lower)) return { type: "BACK" }

  // --- travel to hotel (lounge → hotel transition) ---
  if (TRAVEL_TO_HOTEL_RE.test(lower)) return { type: "TRAVEL_TO_HOTEL" }

  // --- booking intent ---
  if (BOOK_RE.test(lower)) return { type: "BOOK" }

  // --- Question guard: if the user is asking a question without a navigation
  //     action verb, skip all navigation keyword matching. This prevents
  //     "what's the room area?" from triggering ROOMS, or "what's the view?"
  //     from triggering EXTERIOR. Questions WITH action verbs like
  //     "can you show me the rooms?" still match navigation intents. ---
  const isQuestion = QUESTION_RE.test(lower)
  const hasNavAction = NAV_ACTION_RE.test(lower)

  if (isQuestion && !hasNavAction) {
    // Skip navigation intents — fall through to room plan, distribution,
    // affirmative/negative, and finally UNKNOWN
    if (ROOM_PLAN_CHEAPER_RE.test(lower)) return { type: "ROOM_PLAN_CHEAPER" }
    if (ROOM_PLAN_COMPACT_RE.test(lower)) return { type: "ROOM_PLAN_COMPACT" }
    if (ROOM_SEPARATE_RE.test(lower)) return { type: "ROOM_SEPARATE" }
    if (ROOM_TOGETHER_RE.test(lower)) return { type: "ROOM_TOGETHER" }
    if (ROOM_AUTO_RE.test(lower)) return { type: "ROOM_AUTO" }
    if (OTHER_OPTIONS_RE.test(lower)) return { type: "OTHER_OPTIONS" }
    if (AFFIRMATIVE_RE.test(lower)) return { type: "AFFIRMATIVE" }
    if (NEGATIVE_RE.test(lower)) return { type: "NEGATIVE" }
    return { type: "UNKNOWN" }
  }

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
