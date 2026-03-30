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

export interface Room {
  id: string
  name: string
  occupancy: string
  price: number
  hotelId: string
  image: string
  book_url: string
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
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/standard-lake-view/"
  },
  {
    id: "r2",
    name: "Penthouse",
    occupancy: "6",
    price: 599,
    hotelId: "1",
    image: "/images/room-suite-double.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/penthouse/"
  },
  {
    id: "r3",
    name: "Loft Suite Lake View",
    occupancy: "4",
    price: 399,
    hotelId: "1",
    image: "/images/room-suite-triple.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/loft-suite-lake-view-balcony/"
  },
  {
    id: "r4",
    name: "Standard Mountain View",
    occupancy: "2",
    price: 199,
    hotelId: "1",
    image: "/images/standard_mountain_view.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/standard/"
  },
  {
    id: "r5",
    name: "Loft Suite Mountain View",
    occupancy: "4",
    price: 349,
    hotelId: "1",
    image: "/images/loft_mountain_view.jpg",
    book_url: "https://www.editionhotels.com/lake-como/rooms-and-suites/loft-suite-mountain-view/"
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

export type DistributionPreference = "together" | "separate" | "auto"

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

type GuestCompositionInput = { adults: number; children: number; childrenAges?: number[] }

/**
 * Infer the best distribution strategy from travel purpose + explicit preference.
 * - Business trips default to separate rooms (1-2 per room).
 * - Family/romantic trips default to minimizing room count.
 * - "auto" uses heuristics when no preference is stated.
 */
function resolveDistribution(
  preference: DistributionPreference | undefined,
  travelPurpose: string | undefined,
  partySize: number,
): "pack" | "spread" {
  if (preference === "together") return "pack"
  if (preference === "separate") return "spread"

  // Auto-resolve based on travel purpose
  const purpose = travelPurpose?.toLowerCase() ?? ""
  if (purpose.includes("business")) return "spread"
  if (
    purpose.includes("family") || purpose.includes("romantic") ||
    purpose.includes("honeymoon") || purpose.includes("couple")
  ) return "pack"

  // Default: pack for small groups, spread for large
  return partySize <= 4 ? "pack" : "spread"
}

function parseBudgetNumber(budgetRange: string | undefined): number | null {
  if (!budgetRange) return null
  const num = parseInt(budgetRange.replace(/[^0-9]/g, ""))
  return num > 0 ? num : null
}

/**
 * Generate all valid multi-room plans that accommodate the given party size.
 * Uses a bounded greedy approach — tries combinations with each room type as primary.
 */
function generateCandidatePlans(rooms: Room[], partySize: number): RoomPlan[] {
  const plans: RoomPlan[] = []
  const sortedRooms = [...rooms].sort((a, b) => parseInt(b.occupancy) - parseInt(a.occupancy))

  // Strategy 1: Fill with a single room type (when possible)
  for (const room of sortedRooms) {
    const cap = parseInt(room.occupancy)
    const qty = Math.ceil(partySize / cap)
    plans.push(buildPlan([{ room, qty }]))
  }

  // Strategy 2: Mixed — use the largest room first, fill remainder with smallest
  if (sortedRooms.length >= 2) {
    const largest = sortedRooms[0]
    const smallest = sortedRooms[sortedRooms.length - 1]
    const largeCap = parseInt(largest.occupancy)
    const smallCap = parseInt(smallest.occupancy)

    if (largest.id !== smallest.id) {
      // Try 1 large + remainder in small
      const remaining = partySize - largeCap
      if (remaining > 0) {
        const smallQty = Math.ceil(remaining / smallCap)
        plans.push(buildPlan([{ room: largest, qty: 1 }, { room: smallest, qty: smallQty }]))
      }

      // Try combinations with increasing large rooms
      for (let largeQty = 2; largeQty * largeCap < partySize + largeCap; largeQty++) {
        const rem = partySize - largeQty * largeCap
        if (rem <= 0) {
          plans.push(buildPlan([{ room: largest, qty: largeQty }]))
          break
        }
        const sQty = Math.ceil(rem / smallCap)
        plans.push(buildPlan([{ room: largest, qty: largeQty }, { room: smallest, qty: sQty }]))
      }
    }

    // Try mid-sized room + smallest for variety
    if (sortedRooms.length >= 3) {
      const mid = sortedRooms[1]
      const midCap = parseInt(mid.occupancy)
      if (mid.id !== smallest.id) {
        for (let midQty = 1; midQty * midCap < partySize + midCap; midQty++) {
          const rem = partySize - midQty * midCap
          if (rem <= 0) {
            plans.push(buildPlan([{ room: mid, qty: midQty }]))
            break
          }
          const sQty = Math.ceil(rem / smallCap)
          plans.push(buildPlan([{ room: mid, qty: midQty }, { room: smallest, qty: sQty }]))
        }
      }
    }
  }

  return plans
}

function buildPlan(items: { room: Room; qty: number }[]): RoomPlan {
  const entries: RoomPlanEntry[] = items.map(({ room, qty }) => ({
    roomId: room.id,
    roomName: room.name,
    quantity: qty,
    pricePerNight: room.price,
    occupancy: parseInt(room.occupancy),
  }))

  return {
    entries,
    totalCapacity: entries.reduce((sum, e) => sum + e.occupancy * e.quantity, 0),
    totalPricePerNight: entries.reduce((sum, e) => sum + e.pricePerNight * e.quantity, 0),
  }
}

/**
 * Given a room allocation (e.g., [4, 2]), find the best room type for each slot.
 * Each number represents how many guests go in that room.
 * Groups identical guest counts so e.g. [2, 2] → one entry with qty=2.
 */
export function getAllocationBasedRoomPlan(
  rooms: Room[],
  roomAllocation: number[],
  budgetRange?: string,
): RoomPlan | null {
  if (roomAllocation.length === 0 || rooms.length === 0) return null

  const budgetNum = parseBudgetNumber(budgetRange)

  // Group identical guest counts: { guestCount → quantity }
  const allocationCounts = new Map<number, number>()
  for (const guestCount of roomAllocation) {
    allocationCounts.set(guestCount, (allocationCounts.get(guestCount) ?? 0) + 1)
  }

  const entries: RoomPlanEntry[] = []

  for (const [guestCount, qty] of allocationCounts) {
    // Find rooms that can fit this many guests
    const fitting = rooms.filter(r => parseInt(r.occupancy) >= guestCount)
    if (fitting.length === 0) return null // can't accommodate this slot

    let best: Room
    if (budgetNum && budgetNum > 0) {
      // Closest to per-room budget
      best = [...fitting].sort((a, b) =>
        Math.abs(a.price - budgetNum) - Math.abs(b.price - budgetNum)
      )[0]
    } else {
      // Least capacity waste, then cheapest
      best = [...fitting].sort((a, b) => {
        const wasteA = parseInt(a.occupancy) - guestCount
        const wasteB = parseInt(b.occupancy) - guestCount
        return wasteA !== wasteB ? wasteA - wasteB : a.price - b.price
      })[0]
    }

    entries.push({
      roomId: best.id,
      roomName: best.name,
      quantity: qty,
      pricePerNight: best.price,
      occupancy: parseInt(best.occupancy),
      guestCount,
    })
  }

  return {
    entries,
    totalCapacity: entries.reduce((sum, e) => sum + e.occupancy * e.quantity, 0),
    totalPricePerNight: entries.reduce((sum, e) => sum + e.pricePerNight * e.quantity, 0),
  }
}

/**
 * Recommend an optimal multi-room plan for a party.
 *
 * When roomAllocation is provided, uses allocation-based matching.
 * Otherwise falls back to distribution preference heuristics.
 */
export function getRecommendedRoomPlan(
  rooms: Room[],
  partySize: number | undefined,
  guestComposition: GuestCompositionInput | undefined,
  travelPurpose: string | undefined,
  budgetRange: string | undefined,
  distributionPreference: DistributionPreference | undefined,
  roomAllocation?: number[],
): RoomPlan | null {
  // If explicit room allocation is provided, use allocation-based engine
  if (roomAllocation && roomAllocation.length > 0) {
    return getAllocationBasedRoomPlan(rooms, roomAllocation, budgetRange)
  }

  if (!partySize || partySize <= 0 || rooms.length === 0) return null

  const strategy = resolveDistribution(distributionPreference, travelPurpose, partySize)
  const budgetNum = parseBudgetNumber(budgetRange)

  // Check if any single room fits the entire party
  const maxOccupancy = Math.max(...rooms.map((r) => parseInt(r.occupancy)))
  const fitsInOne = maxOccupancy >= partySize

  // For "spread" strategy, target 1-2 guests per room (business-style)
  if (strategy === "spread") {
    const smallestRooms = [...rooms].sort((a, b) => parseInt(a.occupancy) - parseInt(b.occupancy))
    const smallest = smallestRooms[0]
    const smallCap = parseInt(smallest.occupancy)

    // Each person gets their own room (or 2 per room if budget-conscious)
    const adults = guestComposition?.adults ?? partySize
    const children = guestComposition?.children ?? 0

    // Adults get individual rooms; children share with adults
    const adultRoomCount = adults
    const childrenNeedingRoom = Math.max(0, children - adults) // extra children beyond 1-per-adult
    const extraRooms = childrenNeedingRoom > 0 ? Math.ceil(childrenNeedingRoom / smallCap) : 0
    const totalRooms = adultRoomCount + extraRooms

    // Pick the smallest room type for spread
    const plan = buildPlan([{ room: smallest, qty: totalRooms }])

    // If budget is specified and plan is too expensive, try 2-per-room
    if (budgetNum && plan.totalPricePerNight > budgetNum * 1.5) {
      const pairedRooms = Math.ceil(partySize / smallCap)
      const budgetPlan = buildPlan([{ room: smallest, qty: pairedRooms }])
      return budgetPlan
    }

    return plan
  }

  // For "pack" strategy, minimize room count
  if (fitsInOne) {
    // Single room can hold everyone — pick the best one
    const fitting = rooms.filter((r) => parseInt(r.occupancy) >= partySize)
    if (fitting.length > 0) {
      let best: Room
      if (budgetNum && budgetNum > 0) {
        best = [...fitting].sort((a, b) => Math.abs(a.price - budgetNum) - Math.abs(b.price - budgetNum))[0]
      } else {
        best = [...fitting].sort((a, b) => a.price - b.price)[0]
      }
      return buildPlan([{ room: best, qty: 1 }])
    }
  }

  // Need multiple rooms — generate candidates and score them
  const candidates = generateCandidatePlans(rooms, partySize)
  if (candidates.length === 0) return null

  // Score: lower is better
  const scored = candidates.map((plan) => {
    const waste = plan.totalCapacity - partySize // unused bed slots
    const roomCount = plan.entries.reduce((sum, e) => sum + e.quantity, 0)
    const budgetDiff = budgetNum ? Math.abs(plan.totalPricePerNight - budgetNum) : 0

    // Pack strategy: strongly prefer fewer rooms, then less waste, then budget match
    const score = roomCount * 10000 + waste * 100 + budgetDiff
    return { plan, score }
  })

  scored.sort((a, b) => a.score - b.score)
  return scored[0].plan
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

// ---------------------------------------------------------------------------
// Alternative plan generators (used for dynamic plan adjustments)
// ---------------------------------------------------------------------------

/**
 * Generate the cheapest possible plan that accommodates the party.
 * Prioritizes lowest total price, then fewest rooms, then least waste.
 */
export function getBudgetRoomPlan(
  rooms: Room[],
  partySize: number,
  roomAllocation?: number[],
): RoomPlan | null {
  if (partySize <= 0 || rooms.length === 0) return null

  // If allocation is provided, find cheapest room for each slot
  if (roomAllocation && roomAllocation.length > 0) {
    const allocationCounts = new Map<number, number>()
    for (const gc of roomAllocation) {
      allocationCounts.set(gc, (allocationCounts.get(gc) ?? 0) + 1)
    }
    const entries: RoomPlanEntry[] = []
    for (const [guestCount, qty] of allocationCounts) {
      const fitting = rooms.filter(r => parseInt(r.occupancy) >= guestCount)
      if (fitting.length === 0) return null
      const cheapest = [...fitting].sort((a, b) => a.price - b.price)[0]
      entries.push({
        roomId: cheapest.id,
        roomName: cheapest.name,
        quantity: qty,
        pricePerNight: cheapest.price,
        occupancy: parseInt(cheapest.occupancy),
        guestCount,
      })
    }
    return {
      entries,
      totalCapacity: entries.reduce((sum, e) => sum + e.occupancy * e.quantity, 0),
      totalPricePerNight: entries.reduce((sum, e) => sum + e.pricePerNight * e.quantity, 0),
    }
  }

  const candidates = generateCandidatePlans(rooms, partySize)
  if (candidates.length === 0) return null

  const scored = candidates.map((plan) => {
    const waste = plan.totalCapacity - partySize
    const roomCount = plan.entries.reduce((sum, e) => sum + e.quantity, 0)
    // Budget: lowest price first, then fewer rooms, then less waste
    const score = plan.totalPricePerNight * 1000 + roomCount * 100 + waste
    return { plan, score }
  })

  scored.sort((a, b) => a.score - b.score)
  return scored[0].plan
}

/**
 * Generate the most compact plan (fewest rooms possible).
 */
export function getCompactRoomPlan(
  rooms: Room[],
  partySize: number,
): RoomPlan | null {
  if (partySize <= 0 || rooms.length === 0) return null

  const candidates = generateCandidatePlans(rooms, partySize)
  if (candidates.length === 0) return null

  const scored = candidates.map((plan) => {
    const waste = plan.totalCapacity - partySize
    const roomCount = plan.entries.reduce((sum, e) => sum + e.quantity, 0)
    // Compact: fewest rooms first, then least waste, then cheapest
    const score = roomCount * 100000 + waste * 1000 + plan.totalPricePerNight
    return { plan, score }
  })

  scored.sort((a, b) => a.score - b.score)
  return scored[0].plan
}

/**
 * Build a plan from explicit user-specified room quantities.
 * Returns the plan and a warning if total capacity doesn't cover the party.
 *
 * @param requests Array of { roomId, quantity } the user asked for
 * @param rooms All available rooms (for price/name lookup)
 * @param partySize Total guests (for capacity validation)
 */
export function buildExplicitRoomPlan(
  requests: { roomId: string; quantity: number }[],
  rooms: Room[],
  partySize: number | undefined,
): { plan: RoomPlan; warning: string | null } {
  const items: { room: Room; qty: number }[] = []
  for (const req of requests) {
    const room = rooms.find((r) => r.id === req.roomId)
    if (room) {
      items.push({ room, qty: req.quantity })
    }
  }

  if (items.length === 0) {
    return {
      plan: { entries: [], totalCapacity: 0, totalPricePerNight: 0 },
      warning: "I couldn't find those room types. Could you try again?",
    }
  }

  const plan = buildPlan(items)

  let warning: string | null = null
  if (partySize && plan.totalCapacity < partySize) {
    warning = `That combination holds ${plan.totalCapacity} guests, but your group has ${partySize}. You might need an additional room to fit everyone.`
  }

  return { plan, warning }
}

/**
 * Try to match room names/types from a user's free-text message.
 * Returns an array of { roomId, quantity } or null if no rooms matched.
 *
 * Handles patterns like:
 * - "4 standard rooms and 2 loft suites"
 * - "3 of the lake view and 1 penthouse"
 * - "two mountain view rooms"
 */
export function parseExplicitRoomRequests(
  message: string,
  rooms: Room[],
): { roomId: string; quantity: number }[] | null {
  const lower = message.toLowerCase()
  const results: { roomId: string; quantity: number }[] = []

  const wordToNum: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  }

  for (const room of rooms) {
    // Build match keywords from room name
    const nameLower = room.name.toLowerCase()
    const nameWords = nameLower.split(/\s+/)

    // Check if any distinguishing part of the room name appears in the message
    // Use the most specific match (e.g., "standard lake view" > "standard")
    let matched = false
    if (lower.includes(nameLower)) {
      matched = true
    } else {
      // Try partial matches: "lake view", "mountain view", "penthouse", "loft suite", "standard"
      const partials = [
        nameWords.slice(0, 2).join(" "), // e.g., "standard lake"
        nameWords.slice(1).join(" "),     // e.g., "lake view"
        nameWords[0],                     // e.g., "standard"
        nameWords[nameWords.length - 1],  // e.g., "view"
      ].filter((p) => p.length > 3) // skip very short words

      for (const partial of partials) {
        if (lower.includes(partial)) {
          matched = true
          break
        }
      }
    }

    if (!matched) continue

    // Find the quantity preceding or near the room name mention
    // Pattern: "4 standard" or "four lake view" or "2 of the penthouse"
    const qtyPatterns = [
      new RegExp(`(\\d+)\\s+(?:of\\s+(?:the\\s+)?)?(?:${nameWords.join("[\\s-]*")})`, "i"),
      new RegExp(`(\\d+)\\s+(?:of\\s+(?:the\\s+)?)?(?:${nameWords.slice(0, 2).join("[\\s-]*")})`, "i"),
      new RegExp(`(\\d+)\\s+(?:of\\s+(?:the\\s+)?)?(?:${nameWords[0]})`, "i"),
      // Word numbers: "two standard"
      new RegExp(`(one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:of\\s+(?:the\\s+)?)?(?:${nameWords[0]})`, "i"),
    ]

    let qty = 1 // default to 1 if name mentioned but no number
    for (const pattern of qtyPatterns) {
      const match = lower.match(pattern)
      if (match?.[1]) {
        const parsed = wordToNum[match[1].toLowerCase()] ?? parseInt(match[1])
        if (parsed > 0) {
          qty = parsed
          break
        }
      }
    }

    results.push({ roomId: room.id, quantity: qty })
  }

  return results.length > 0 ? results : null
}
