// ---------------------------------------------------------------------------
// Intent Classifier — single source of truth for user intent detection
// ---------------------------------------------------------------------------
// All regex patterns from the old JourneyOrchestrator consolidated here.
// Pure function, no React dependency — easy to unit test and swap for AI NLU.
// ---------------------------------------------------------------------------

export type UserIntent =
  | { type: "ROOMS" }
  | { type: "AMENITIES" }
  | { type: "LOCATION" }
  | { type: "INTERIOR" }
  | { type: "EXTERIOR" }
  | { type: "BACK" }
  | { type: "HOTEL_EXPLORE" }
  | { type: "DOWNLOAD_DATA" }
  | { type: "UNKNOWN" }

const DOWNLOAD_DATA_RE = /\bdownload\s+user\s+data\b/
const ROOM_RE = /\b(room|rooms|suite|suites|book|stay|bed|accommodation)\b/
const AMENITY_RE = /\b(amenity|amenities|spa|pool|gym|restaurant|bar|facility|facilities)\b/
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
 *   BACK > INTERIOR / EXTERIOR > HOTEL_EXPLORE > single-panel (ROOMS / AMENITIES / LOCATION)
 *
 * Returns `{ type: "UNKNOWN" }` when the message doesn't match any pattern
 * or when multiple panel intents are ambiguous.
 */
export function classifyIntent(message: string): UserIntent {
  const lower = message.toLowerCase()

  // --- admin command: download user data ---
  if (DOWNLOAD_DATA_RE.test(lower)) return { type: "DOWNLOAD_DATA" }

  // --- highest priority: navigation commands ---
  if (BACK_RE.test(lower)) return { type: "BACK" }

  // --- view commands (interior / exterior) ---
  const wantsInterior = INTERIOR_RE.test(lower)
  const wantsExterior = EXTERIOR_RE.test(lower)
  if (wantsInterior && !wantsExterior) return { type: "INTERIOR" }
  if (wantsExterior && !wantsInterior) return { type: "EXTERIOR" }

  // --- hotel-level explore ---
  if (HOTEL_EXPLORE_RE.test(lower)) return { type: "HOTEL_EXPLORE" }

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

  return { type: "UNKNOWN" }
}
