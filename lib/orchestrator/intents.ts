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
  | { type: "UNKNOWN" }

const DOWNLOAD_DATA_RE = /\bdownload\s+user\s+data\b/
const ROOM_RE = /\b(room|rooms|suite|suites|stay|bed|accommodation)\b/
const BOOK_RE = /\b(book\s*(?:it|this|that|the\s+room|now)?|reserve|make\s+(?:a\s+)?reservation|proceed\s+(?:with\s+)?(?:booking|reservation)|let'?s\s+(?:book|reserve|do\s+it)|i(?:'d| would)\s+(?:like\s+to\s+)?(?:book|reserve)|i(?:'ll| will)\s+take\s+(?:it|this|that)|sign\s+me\s+up)\b/i
const AMENITY_RE = /\b(amenity|amenities|facility|facilities)\b/
const AMENITY_NAME_RE = /\b(lobby|conference|spa|restaurant|pool|gym|bar|lounge|dining)\b/
const LOCATION_RE = /\b(location|surrounding|surroundings|area|neighbou?rhood|outside|around|nearby|map|walk)\b/
const INTERIOR_RE = /\b(interior|inside|indoor|in)\b/
const EXTERIOR_RE = /\b(exterior|outside|outdoor|out|view)\b/
const BACK_RE = /\b(back|return|cancel|nevermind|never mind|go back)\b/
const HOTEL_EXPLORE_RE =
  /(?:\b(explore|tour|see|show|walk around|look around|view)\b.*\bhotel\b|\bhotel\b.*\b(explore|tour|see|show|walk around|look around|view)\b|\bhotel view\b)/

/**
 * Classify a user utterance into a navigation / action intent.
 *
 * Priority order (highest → lowest):
 *   DOWNLOAD_DATA > BACK > INTERIOR / EXTERIOR > HOTEL_EXPLORE >
 *   AMENITY_BY_NAME > AMENITIES (generic) > ROOMS / LOCATION
 */
export function classifyIntent(message: string): UserIntent {
  const lower = message.toLowerCase()

  // --- admin command: download user data ---
  if (DOWNLOAD_DATA_RE.test(lower)) return { type: "DOWNLOAD_DATA" }

  // --- highest priority: navigation commands ---
  if (BACK_RE.test(lower)) return { type: "BACK" }

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

  return { type: "UNKNOWN" }
}
