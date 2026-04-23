export interface Hotel {
  id: string
  name: string
  slug: string
  location: string
  description: string
  image: string
  active: boolean
  coordinates: { lat: number; lng: number }
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

export interface Amenity {
  id: string
  name: string
  hotelId: string
  scene: string
  image: string
}

export const hotels: Hotel[] = [
  {
    id: "1",
    name: "EDITION | Lake Como",
    slug: "edition-lake-como",
    location: "Lake Como, Italy",
    description: "Luxury lakeside retreat with stunning mountain views",
    image: "/images/edition-como.jpg",
    active: true,
    coordinates: { lat: 45.9931, lng: 9.2658 },
  },
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

export const rooms: Room[] = [
  {
    id: "r1",
    name: "Standard Lake View",
    occupancy: "2",
    price: 249,
    hotelId: "1",
    image: "/images/room-standard.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/standard-lake-view/",
    area: {
      min_sqm: 27,
      max_sqm: 34,
      label: "27-34 SQM",
    },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Rollaway Bed not permitted",
      "Baby cot available upon request",
    ],
    view: ["Lake view"],
    bedding: [
      "Down comforter pillows",
      "Custom imported linens",
    ],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Single vanity",
      "Custom Le Labo amenities",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r2",
    name: "Penthouse",
    occupancy: "6",
    price: 599,
    hotelId: "1",
    image: "/images/room-suite-double.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/penthouse/",
    area: {
      min_sqm: 111,
      max_sqm: 111,
      label: "111 SQM",
    },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Private terrace",
      "Nespresso machine",
      "Clothing steamer",
      "Top floor",
      "Separate living area with sofa and lounge chairs",
      "Dining room and fully equipped kitchen",
      "Floor to ceiling windows",
      "Fridge",
      "Iron and ironing board upon request",
      "Minibar",
      "In-room safe",
      "Connecting rooms available",
      "Rollaway Bed available upon request at extra cost (up to 16 years old)",
    ],
    view: ["Lake view", "Mountain view"],
    bedding: [
      "Down comforter pillows",
      "Custom imported linens",
    ],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Standalone bathtub",
      "Custom Le Labo amenities with exclusive signature EDITION scent",
      "Single vanity",
      "Make-up mirror",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r3",
    name: "Loft Suite Lake View",
    occupancy: "4",
    price: 399,
    hotelId: "1",
    image: "/images/room-suite-triple.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/loft-suite-lake-view-balcony/",
    area: {
      min_sqm: 41,
      max_sqm: 54,
      label: "41-54 SQM",
    },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Baby cot available upon request",
      "Rollaway Bed available upon request at extra cost (up to 16 years old)",
    ],
    view: ["Lake view"],
    bedding: [
      "Down comforter pillows",
      "Custom imported linens",
    ],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Bathtub",
      "Single vanity",
      "Custom Le Labo amenities with exclusive signature EDITION scent",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r4",
    name: "Standard Mountain View",
    occupancy: "2",
    price: 199,
    hotelId: "1",
    image: "/images/standard_mountain_view.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/standard/",
    area: {
      min_sqm: 25,
      max_sqm: 32,
      label: "25-32 SQM",
    },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Rollaway Bed not permitted",
    ],
    view: ["Mountain view"],
    bedding: [
      "Down comforter pillows",
      "Custom imported linens",
    ],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Single vanity",
      "Custom Le Labo amenities",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
  {
    id: "r5",
    name: "Loft Suite Mountain View",
    occupancy: "4",
    price: 349,
    hotelId: "1",
    image: "/images/loft_mountain_view.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/loft-suite-mountain-view/",
    area: {
      min_sqm: 49,
      max_sqm: 51,
      label: "49-51 SQM",
    },
    roomType: "King bed",
    features: [
      "Air-conditioned rooms",
      "Nespresso machine",
      "Clothing steamer",
      "Iron & ironing board upon request",
      "Minibar",
      "In-room safe",
      "Baby cot available upon request",
      "Rollaway Bed available upon request at extra cost (up to 16 years old)",
    ],
    view: ["Mountain view"],
    bedding: [
      "Down comforter pillows",
      "Custom imported linens",
    ],
    bath: [
      "White marble bathroom with enclosed rain walk-in shower",
      "Bathtub",
      "Single vanity",
      "Custom Le Labo amenities with exclusive signature EDITION scent",
      "Hairdryer",
      "Robes & slippers",
    ],
    tech: [
      "Complimentary high-speed Wi-Fi",
      "55\" Flat screen SMART HDTV with streaming capabilities",
      "Bang & Olufsen Beoplay Bluetooth speaker",
    ],
    services: [
      "Twice-daily housekeeping service",
      "Complimentary bottled water daily",
      "Digital Press available",
    ],
  },
]

export const amenities: Amenity[] = [
  {
    id: "a1",
    name: "Lobby",
    hotelId: "1",
    scene: "lobby",
    image: "/images/amenity-lobby.jpg",
  },
  {
    id: "a2",
    name: "Conference Room",
    hotelId: "1",
    scene: "conference",
    image: "/images/amenity-conference.jpg",
  },
  {
    id: "a3",
    name: "Pool",
    hotelId: "1",
    scene: "pool",
    image: "/images/amenity-conference.jpg",
  },
]

export function getHotelBySlug(slug: string): Hotel | undefined {
  return hotels.find((h) => h.slug === slug)
}

export function getRoomsByHotelId(hotelId: string): Room[] {
  return rooms.filter((r) => r.hotelId === hotelId)
}

export function getAmenitiesByHotelId(hotelId: string): Amenity[] {
  return amenities.filter((a) => a.hotelId === hotelId)
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

export interface HotelCatalog {
  hotelSlug: string
  hotelName: string
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
  amenities: Array<{
    id: string
    name: string
    /** UE5 scene identifier (matches Amenity.scene). */
    scene: string
    /** Optional speech aliases so the LLM can accept synonyms. */
    aliases?: string[]
  }>
  tools: {
    /** Canonical navigation intent names the orchestrate tool schema may reference. */
    navigationIntents: string[]
    /** Canonical amenity names the LLM is allowed to speak / pass as `amenityName`. */
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
export function getHotelCatalog(slug: string): HotelCatalog | null {
  const hotel = getHotelBySlug(slug)
  if (!hotel) return null

  const hotelRooms = getRoomsByHotelId(hotel.id)
  const hotelAmenities = getAmenitiesByHotelId(hotel.id)

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

  const packedAmenities = hotelAmenities.map((a) => {
    const aliases = AMENITY_NAME_ALIASES[a.scene.toLowerCase()]
    return {
      id: a.id,
      name: a.name,
      scene: a.scene,
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
    }
  })

  return {
    hotelSlug: hotel.slug,
    hotelName: hotel.name,
    rooms: packedRooms,
    amenities: packedAmenities,
    tools: {
      navigationIntents: [...NAVIGATION_INTENTS],
      amenityNames: packedAmenities.map((a) => a.name),
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
