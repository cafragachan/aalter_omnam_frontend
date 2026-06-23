import { getHotelCatalog } from "@/lib/hotel-data"
import type { UserProfile, GuestComposition } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import type { UnitInventoryEntry } from "@/lib/selection"

const DEFAULT_AGENT_HOTEL_SLUG = "edition-lake-como"

export type AgentToolCoreOptions = {
  slug?: string
}

export type UnitSelectionValidation = {
  ok: boolean
  unitIds: number[]
  message: string
}

export function parseProfileUpdates(args: Record<string, unknown>): Partial<UserProfile> {
  const updates: Partial<UserProfile> = {}

  if (typeof args.firstName === "string" && args.firstName.trim()) {
    updates.firstName = args.firstName.trim()
  }

  const guestComposition: Partial<GuestComposition> = {}
  if (Number.isFinite(Number(args.adults))) guestComposition.adults = Number(args.adults)
  if (Number.isFinite(Number(args.children))) guestComposition.children = Number(args.children)
  if (Array.isArray(args.childrenAges)) {
    guestComposition.childrenAges = args.childrenAges.map(Number).filter(Number.isFinite)
  }
  if (Object.keys(guestComposition).length) updates.guestComposition = guestComposition as GuestComposition

  const start = parseDate(args.startDate)
  if (start) updates.startDate = start
  const end = parseDate(args.endDate)
  if (end) updates.endDate = end

  if (Array.isArray(args.interests)) updates.interests = args.interests.map(String)
  if (typeof args.travelPurpose === "string") updates.travelPurpose = args.travelPurpose
  if (typeof args.budgetRange === "string") updates.budgetRange = args.budgetRange
  if (Array.isArray(args.dietaryRestrictions)) updates.dietaryRestrictions = args.dietaryRestrictions.map(String)
  if (Array.isArray(args.accessibilityNeeds)) updates.accessibilityNeeds = args.accessibilityNeeds.map(String)

  return updates
}

export function summarizeProfile(updates: Partial<UserProfile>): string {
  const bits: string[] = []
  if (updates.firstName) bits.push(updates.firstName)
  if (updates.guestComposition) {
    const { adults, children, childrenAges } = updates.guestComposition
    const party: string[] = []
    if (typeof adults === "number") party.push(`${adults} adult${adults === 1 ? "" : "s"}`)
    if (typeof children === "number" && children > 0) party.push(`${children} child${children === 1 ? "" : "ren"}`)
    if (childrenAges?.length) party.push(`ages ${childrenAges.join(", ")}`)
    if (party.length) bits.push(party.join(" + "))
  }
  if (updates.startDate) {
    bits.push(`from ${updates.startDate.toISOString().slice(0, 10)}${updates.endDate ? ` to ${updates.endDate.toISOString().slice(0, 10)}` : ""}`)
  } else if (updates.endDate) {
    bits.push(`to ${updates.endDate.toISOString().slice(0, 10)}`)
  }
  if (updates.interests?.length) bits.push(updates.interests.join(", "))
  if (updates.travelPurpose) bits.push(updates.travelPurpose)
  if (updates.budgetRange) bits.push(updates.budgetRange)
  if (updates.dietaryRestrictions?.length) bits.push(`dietary: ${updates.dietaryRestrictions.join(", ")}`)
  if (updates.accessibilityNeeds?.length) bits.push(`access: ${updates.accessibilityNeeds.join(", ")}`)
  return bits.join("; ") || "a detail"
}

export function buildRoomPlan(rawRooms: unknown, options: AgentToolCoreOptions = {}): CurrentRoomPlan | null {
  const cat = getHotelCatalog(options.slug ?? DEFAULT_AGENT_HOTEL_SLUG)
  const raw = Array.isArray(rawRooms) ? (rawRooms as Array<Record<string, unknown>>) : []
  const rooms: CurrentRoomPlan["rooms"] = []
  let totalPerNight = 0
  let capacity = 0

  for (const item of raw) {
    const roomId = String(item.roomId ?? "")
    const quantity = Math.max(1, Math.floor(Number(item.quantity ?? 1)) || 1)
    const room = cat?.rooms.find((candidate) => candidate.id === roomId)
    if (!room) continue
    rooms.push({ roomId, quantity })
    totalPerNight += room.price * quantity
    capacity += room.occupancy * quantity
  }

  return rooms.length ? { rooms, totalPerNight, capacity, source: "planner" } : null
}

export function summarizeRoomPlan(plan: CurrentRoomPlan, options: AgentToolCoreOptions = {}): string {
  const cat = getHotelCatalog(options.slug ?? DEFAULT_AGENT_HOTEL_SLUG)
  return plan.rooms
    .map((entry) => `${entry.quantity}x ${cat?.rooms.find((room) => room.id === entry.roomId)?.name ?? entry.roomId}`)
    .join(", ")
}

export function validatePlanCapacity(plan: CurrentRoomPlan, partySize?: number): string | null {
  if (partySize && plan.capacity < partySize) {
    return `That plan only sleeps ${plan.capacity}, but the party is ${partySize}. Add a room or pick larger ones so everyone fits, then propose again.`
  }
  return null
}

export function validateUnitSelection(args: Record<string, unknown>, inventory: UnitInventoryEntry[], plan: CurrentRoomPlan | null): UnitSelectionValidation {
  const requestedIds = Array.isArray(args.unitIds) ? args.unitIds.map(Number).filter(Number.isFinite) : []
  const availableIds = requestedIds.filter((id) => inventory.some((unit) => unit.id === id && unit.available))
  if (!availableIds.length) {
    return {
      ok: false,
      unitIds: [],
      message: "None of those unit ids are available. Pick available ids from the inventory.",
    }
  }

  const planTypes = new Set((plan?.rooms ?? []).map((room) => room.roomId))
  const inPlan = availableIds.filter((id) => {
    const unit = inventory.find((candidate) => candidate.id === id)
    return !!unit && planTypes.has(unit.roomTypeId)
  })

  if (!inPlan.length) {
    return {
      ok: false,
      unitIds: [],
      message: "Those units are not part of the current plan's room types. Call propose_room_plan to add that room type first, then highlight the unit.",
    }
  }

  const names = inPlan.map((id) => inventory.find((unit) => unit.id === id)?.name ?? id).join(", ")
  const skipped = availableIds.length - inPlan.length
  return {
    ok: true,
    unitIds: inPlan,
    message: `Highlighted ${names}.` + (skipped ? ` (${skipped} unit(s) not in the current plan's room types were skipped. Add them with propose_room_plan.)` : ""),
  }
}

export function bookingRoomFromPlan(args: Record<string, unknown>, plan: CurrentRoomPlan | null, fallbackRoomId?: string | null) {
  const roomId = String(args.roomId ?? "") || fallbackRoomId || plan?.rooms[0]?.roomId || ""
  return getHotelCatalog(DEFAULT_AGENT_HOTEL_SLUG)?.rooms.find((room) => room.id === roomId) ?? null
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}
