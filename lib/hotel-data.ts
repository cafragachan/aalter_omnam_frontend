export interface HotelAddress {
  street: string
  city: string
  postalCode: string
  region: string
  country: string
  googleMapsUrl?: string
}

export interface Hotel {
  id: string
  name: string
  slug: string
  location: string
  description: string
  image: string
  active: boolean
  coordinates: { lat: number; lng: number }
  /** Short marketing line — one sentence. */
  tagline?: string
  address?: HotelAddress
  /** Bullet list of marquee selling points. Useful for AI grounding and UI hero sections. */
  highlights?: string[]
  /** Free-form classification keywords (e.g. "lakeside", "wellness"). */
  tags?: string[]
  websiteUrl?: string
}

export interface RoomArea {
  min_sqm: number
  max_sqm: number
  label: string
}

export interface Room {
  id: string
  name: string
  occupancy: string
  price: number
  hotelId: string
  image: string
  book_url: string
  area?: RoomArea
  roomType?: string
  features?: string[]
  view?: string[]
  bedding?: string[]
  bath?: string[]
  tech?: string[]
  services?: string[]
}

/**
 * One window of operation for an amenity. `open`/`close` are "HH:MM" strings;
 * `days` is free-form ("Daily", "Mon-Fri", "Weekends"). Set `is24Hours: true`
 * for around-the-clock services.
 */
export interface OperatingHours {
  label: string
  open: string
  close: string
  days: string
  is24Hours?: boolean
}

export type AmenityCategory =
  | "dining"
  | "bar"
  | "spa"
  | "fitness"
  | "pool"
  | "meetings"
  | "waterfront"
  | "lounge"

export interface Amenity {
  id: string
  name: string
  hotelId: string
  scene: string
  image: string
  /**
   * Defaults to `true` when omitted. Inactive amenities are filtered out by
   * `getAmenitiesByHotelId` so they don't surface in the AmenitiesPanel or
   * journey machine — useful for staging data before the UE5 scene exists.
   */
  active?: boolean
  category?: AmenityCategory
  /** Long-form copy — for detail panels and rich AI descriptions. */
  description?: string
  /** One- to two-sentence summary for cards and concise AI mentions. */
  shortDescription?: string
  hours?: OperatingHours[]
  features?: string[]
  highlights?: string[]
  tags?: string[]
  /** Public-facing menu PDF or page. */
  menuUrl?: string
  /** Standalone microsite for the amenity (e.g. partnered restaurant). */
  externalUrl?: string
}

// ---------------------------------------------------------------------------
// Per-hotel data
// ---------------------------------------------------------------------------
//
// Active hotels live in their own files under `lib/hotels/` and are imported
// here. Inactive hotels are kept inline as minimal stubs — when one is
// activated, extract it into `lib/hotels/<slug>.ts` following the lake-como
// template (hotel + rooms + amenities exports).

import { lakeComoAmenities, lakeComoHotel, lakeComoRooms } from "./hotels/lake-como"

const inactiveHotels: Hotel[] = [
  {
    id: "2",
    name: "W | Rome",
    slug: "w-rome",
    location: "Rome, Italy",
    description: "Modern luxury in the heart of the eternal city",
    image: "/images/w-rome.jpg",
    active: false,
    coordinates: { lat: 41.9028, lng: 12.4964 },
  },
  {
    id: "3",
    name: "POST | Rotterdam",
    slug: "post-rotterdam",
    location: "Rotterdam, Netherlands",
    description: "Contemporary design meets Dutch hospitality",
    image: "/images/post-rotterdam.jpg",
    active: false,
    coordinates: { lat: 51.9225, lng: 4.47917 },
  },
]

export const hotels: Hotel[] = [lakeComoHotel, ...inactiveHotels]

export const rooms: Room[] = [...lakeComoRooms]

export const amenities: Amenity[] = [...lakeComoAmenities]

export function getHotelBySlug(slug: string): Hotel | undefined {
  return hotels.find((h) => h.slug === slug)
}

export function getRoomsByHotelId(hotelId: string): Room[] {
  return rooms.filter((r) => r.hotelId === hotelId)
}

/**
 * Returns active amenities for a hotel. Entries with `active: false` are
 * filtered out so they don't surface in the AmenitiesPanel or trigger UE5
 * navigation for scenes that don't exist yet. Pass `includeInactive: true`
 * to retrieve every amenity (e.g. for admin views or AI grounding).
 */
export function getAmenitiesByHotelId(
  hotelId: string,
  options: { includeInactive?: boolean } = {},
): Amenity[] {
  return amenities.filter((a) => {
    if (a.hotelId !== hotelId) return false
    if (options.includeInactive) return true
    return a.active !== false
  })
}

// ---------------------------------------------------------------------------
// Hotel Catalog — server-side packing helper (Phase 2)
// ---------------------------------------------------------------------------
//
// A `HotelCatalog` is a self-contained description of the rooms, amenities,
// and tool-facing metadata for a single hotel. The `/api/start-sandbox-session`
// endpoint ships this down with the session so the client (and, in Phase 3,
// the orchestrate prompt) can read the authoritative list from one place
// instead of re-querying `hotel-data.ts` at multiple call sites.
//
// Everything here is packed from the existing in-memory arrays above — no
// new data. Fields are additive; unknown slugs return `null` so callers can
// fall back to the legacy per-hotel lookups without special-casing errors.

/**
 * Compact address shape carried by the catalog. Drops `street` and
 * `postalCode` — the LLM never speaks them aloud and they're noise in the
 * prompt. The full address remains on the source `Hotel` for UI display.
 */
export interface HotelCatalogAddress {
  city: string
  region: string
  country: string
  googleMapsUrl?: string
}

/**
 * Per-amenity projection shipped in the catalog. Includes long `description`
 * so the orchestrate route can inject full details for the focused amenity
 * (mirrors how `selectedRoom` carries full room data) without a second
 * request roundtrip. The condensed list block in the prompt only renders
 * `shortDescription` to keep token cost down — `description` is reserved
 * for the focused-amenity block.
 */
export interface PackedAmenity {
  id: string
  name: string
  /** UE5 scene identifier (matches Amenity.scene). */
  scene: string
  category?: AmenityCategory
  shortDescription?: string
  description?: string
  highlights?: string[]
  tags?: string[]
  hours?: OperatingHours[]
  features?: string[]
  menuUrl?: string
  externalUrl?: string
  /** Speech aliases so the LLM can accept synonyms. Active amenities only. */
  aliases?: string[]
}

export interface HotelCatalog {
  hotelSlug: string
  hotelName: string
  /** Display location, e.g. "Lake Como, Italy". Always present (sourced from hotel.location). */
  hotelLocation: string
  hotelTagline?: string
  hotelDescription?: string
  hotelHighlights?: string[]
  hotelAddress?: HotelCatalogAddress
  hotelTags?: string[]
  hotelWebsiteUrl?: string
  rooms: Array<{
    id: string
    name: string
    /** Parsed from Room.occupancy ("2") → 2. Falls back to 2 on parse failure. */
    occupancy: number
    price: number
    book_url?: string
    area?: RoomArea
    roomType?: string
    features?: string[]
    view?: string[]
    bedding?: string[]
    bath?: string[]
    tech?: string[]
    services?: string[]
  }>
  /**
   * Amenities the guest can NAVIGATE to in the live tour (scene exists in
   * UE5). Drives both the tool-schema's `amenityName` enum and the
   * AmenitiesPanel's card list.
   */
  amenities: PackedAmenity[]
  /**
   * Amenities at the property that DON'T have a UE5 scene yet — e.g. the
   * Longevity Spa, Cetino, Renzo, the gym, the private dock at Lake Como.
   * The LLM can describe these richly when asked, but must NOT navigate to
   * them. Sourced from amenities with `active: false` on the source data.
   */
  amenitiesDescribedOnly: PackedAmenity[]
  tools: {
    /** Canonical navigation intent names the orchestrate tool schema may reference. */
    navigationIntents: string[]
    /**
     * Canonical amenity names the LLM is allowed to navigate to (active
     * amenities only). Described-only amenities are deliberately excluded
     * — the LLM should mention them in speech but never invoke a navigation
     * tool with their names.
     */
    amenityNames: string[]
  }
}

// Aliases that stay stable across hotels — matches `AMENITY_ALIASES` in
// `useJourney.ts`. Kept here too so the packed catalog carries the full
// amenity-name surface for Phase 3's tool-schema generator.
const AMENITY_NAME_ALIASES: Record<string, string[]> = {
  lobby: ["lounge", "reception", "entrance"],
}

// The navigation intents Phase 3's orchestrate tool catalog will advertise.
// Kept as a module constant so both the catalog packing helper and future
// dynamic tool schemas read from a single source of truth.
const NAVIGATION_INTENTS: string[] = [
  "ROOMS",
  "AMENITIES",
  "LOCATION",
  "INTERIOR",
  "EXTERIOR",
  "BACK",
  "HOTEL_EXPLORE",
]

/**
 * Pack the in-memory hotel/room/amenity data into a serializable catalog for
 * the given slug. Returns `null` for unknown slugs so callers can fall back.
 *
 * This helper must NOT introduce any new data — it only projects what already
 * exists in the `hotels` / `rooms` / `amenities` arrays into the shape the
 * session response and Phase 3's orchestrate tools consume.
 */
function packAmenity(a: Amenity, opts: { withAliases: boolean }): PackedAmenity {
  const aliases = opts.withAliases ? AMENITY_NAME_ALIASES[a.scene.toLowerCase()] : undefined
  return {
    id: a.id,
    name: a.name,
    scene: a.scene,
    ...(a.category ? { category: a.category } : {}),
    ...(a.shortDescription ? { shortDescription: a.shortDescription } : {}),
    ...(a.description ? { description: a.description } : {}),
    ...(a.highlights ? { highlights: a.highlights } : {}),
    ...(a.tags ? { tags: a.tags } : {}),
    ...(a.hours ? { hours: a.hours } : {}),
    ...(a.features ? { features: a.features } : {}),
    ...(a.menuUrl ? { menuUrl: a.menuUrl } : {}),
    ...(a.externalUrl ? { externalUrl: a.externalUrl } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
  }
}

function packHotelAddress(addr: HotelAddress | undefined): HotelCatalogAddress | undefined {
  if (!addr) return undefined
  return {
    city: addr.city,
    region: addr.region,
    country: addr.country,
    ...(addr.googleMapsUrl ? { googleMapsUrl: addr.googleMapsUrl } : {}),
  }
}

export function getHotelCatalog(slug: string): HotelCatalog | null {
  const hotel = getHotelBySlug(slug)
  if (!hotel) return null

  const hotelRooms = getRoomsByHotelId(hotel.id)
  // Pull EVERY amenity for this hotel (active + inactive). We partition into
  // navigable vs. described-only below so the LLM can describe inactive ones
  // in speech without ever being able to navigate to them.
  const allHotelAmenities = getAmenitiesByHotelId(hotel.id, { includeInactive: true })

  const packedRooms = hotelRooms.map((r) => {
    const parsedOccupancy = parseInt(r.occupancy, 10)
    return {
      id: r.id,
      name: r.name,
      occupancy: Number.isFinite(parsedOccupancy) && parsedOccupancy > 0 ? parsedOccupancy : 2,
      price: r.price,
      ...(r.book_url ? { book_url: r.book_url } : {}),
      ...(r.area ? { area: r.area } : {}),
      ...(r.roomType ? { roomType: r.roomType } : {}),
      ...(r.features ? { features: r.features } : {}),
      ...(r.view ? { view: r.view } : {}),
      ...(r.bedding ? { bedding: r.bedding } : {}),
      ...(r.bath ? { bath: r.bath } : {}),
      ...(r.tech ? { tech: r.tech } : {}),
      ...(r.services ? { services: r.services } : {}),
    }
  })

  const activeAmenities: PackedAmenity[] = []
  const describedOnlyAmenities: PackedAmenity[] = []
  for (const a of allHotelAmenities) {
    if (a.active === false) {
      describedOnlyAmenities.push(packAmenity(a, { withAliases: false }))
    } else {
      activeAmenities.push(packAmenity(a, { withAliases: true }))
    }
  }

  return {
    hotelSlug: hotel.slug,
    hotelName: hotel.name,
    hotelLocation: hotel.location,
    ...(hotel.tagline ? { hotelTagline: hotel.tagline } : {}),
    ...(hotel.description ? { hotelDescription: hotel.description } : {}),
    ...(hotel.highlights ? { hotelHighlights: hotel.highlights } : {}),
    ...(packHotelAddress(hotel.address) ? { hotelAddress: packHotelAddress(hotel.address)! } : {}),
    ...(hotel.tags ? { hotelTags: hotel.tags } : {}),
    ...(hotel.websiteUrl ? { hotelWebsiteUrl: hotel.websiteUrl } : {}),
    rooms: packedRooms,
    amenities: activeAmenities,
    amenitiesDescribedOnly: describedOnlyAmenities,
    tools: {
      navigationIntents: [...NAVIGATION_INTENTS],
      // Only ACTIVE amenity names — described-only entries must never appear
      // here so the LLM tool schema doesn't surface them as nav targets.
      amenityNames: activeAmenities.map((a) => a.name),
    },
  }
}

export function getRecommendedAmenity(
  amenities: Amenity[],
  travelPurpose: string | undefined,
): Amenity | null {
  if (!travelPurpose || amenities.length === 0) return null

  const purpose = travelPurpose.toLowerCase()
  let targetScene: string

  if (purpose.includes("business")) {
    targetScene = "conference"
  } else if (
    purpose.includes("leisure") || purpose.includes("romantic") ||
    purpose.includes("honeymoon") || purpose.includes("celebration") ||
    purpose.includes("family") || purpose.includes("adventure")
  ) {
    targetScene = "pool"
  } else {
    return null
  }

  return amenities.find((a) => a.scene.toLowerCase().includes(targetScene)) ?? null
}

export function getRecommendedRoomId(
  rooms: Room[],
  partySize: number | undefined,
  budgetRange: string | undefined,
): string | null {
  if (!partySize || rooms.length === 0) return null

  // Filter rooms that can accommodate the party
  const fitting = rooms.filter((r) => parseInt(r.occupancy) >= partySize)
  if (fitting.length === 0) return null
  if (fitting.length === 1) return fitting[0].id

  // Parse budget if it's a specific number
  const budgetNum = budgetRange ? parseInt(budgetRange.replace(/[^0-9]/g, "")) : null

  if (budgetNum && budgetNum > 0) {
    // Pick closest to budget that fits
    fitting.sort((a, b) => Math.abs(a.price - budgetNum) - Math.abs(b.price - budgetNum))
    return fitting[0].id
  }

  // Default: recommend cheapest that fits (best value)
  fitting.sort((a, b) => a.price - b.price)
  return fitting[0].id
}

// ---------------------------------------------------------------------------
// Multi-room recommendation engine
// ---------------------------------------------------------------------------

export type RoomPlanEntry = {
  roomId: string
  roomName: string
  quantity: number
  pricePerNight: number
  occupancy: number
  /** How many guests this entry serves (from room allocation) */
  guestCount?: number
}

export type RoomPlan = {
  entries: RoomPlanEntry[]
  totalCapacity: number
  totalPricePerNight: number
}

/**
 * Validate whether a party can fit into a single room.
 * Returns a warning message if not, or null if it fits.
 */
export function validateRoomForParty(
  room: Room,
  partySize: number | undefined,
): string | null {
  if (!partySize) return null
  const capacity = parseInt(room.occupancy)
  if (partySize <= capacity) return null
  return `The ${room.name} accommodates up to ${capacity} guests, but your group has ${partySize}. Would you like me to suggest a combination that works?`
}
