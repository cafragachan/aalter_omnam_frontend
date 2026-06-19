"use client"

import type { UserProfile, GuestComposition } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import { getHotelCatalog } from "@/lib/hotel-data"
import { PILOT_HOTEL_SLUG } from "@/lib/realtime/context"
import { makeDebugEvent, type DebugEvent } from "./types"

export type DebugToolDispatcherHooks = {
  saveProfile?: (updates: Partial<UserProfile>) => void
  setRoomPlan?: (plan: CurrentRoomPlan) => void
  addEvent?: (event: DebugEvent) => void
  getPartySize?: () => number | undefined
}

export function createDebugToolDispatcher(hooks: DebugToolDispatcherHooks = {}) {
  const cat = getHotelCatalog(PILOT_HOTEL_SLUG)
  let arrived = false
  let selectedRoomId: string | null = null
  let lastPlanFirstRoomId: string | null = null

  return async function dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    hooks.addEvent?.(makeDebugEvent("tool_called", name, JSON.stringify(args), { name, args }))

    switch (name) {
      case "save_profile": {
        const updates = parseProfileUpdates(args)
        if (Object.keys(updates).length === 0) return "Nothing new to remember."
        hooks.saveProfile?.(updates)
        hooks.addEvent?.(makeDebugEvent("profile_updated", "Profile updated", summarizeProfile(updates), updates))
        return `Remembered: ${summarizeProfile(updates)}.`
      }

      case "travel_to_hotel": {
        arrived = true
        return "Debug mode: marked the guest as arrived at the EDITION Lake Como. Recommend rooms with propose_room_plan next."
      }

      case "return_to_lounge": {
        arrived = false
        return "Debug mode: marked the guest as returned to the virtual lounge."
      }

      case "navigate_to": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        return `Debug mode: would navigate to ${String(args.area ?? "unknown")}.`
      }

      case "go_to_amenity": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        return `Debug mode: would walk the guest to ${String(args.amenity ?? "that amenity")}.`
      }

      case "select_room": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        const id = String(args.roomId ?? "")
        selectedRoomId = id
        const room = cat?.rooms.find((r) => r.id === id)
        return room ? `Debug mode: selected ${room.name}.` : `Debug mode: unknown room id ${id}.`
      }

      case "view_unit": {
        if (!selectedRoomId) return "Debug mode: no room is selected yet."
        return `Debug mode: would show ${String(args.view ?? "interior")} for ${selectedRoomId}.`
      }

      case "set_lighting": {
        return `Debug mode: would set lighting to ${String(args.mode ?? "unknown")}.`
      }

      case "show_points_of_interest": {
        return `Debug mode: would map nearby ${String(args.category ?? "points of interest")}.`
      }

      case "propose_room_plan": {
        const plan = buildRoomPlan(args.rooms)
        if (!plan) return "Debug mode: none of those room ids exist. Pick from the catalog."
        const party = hooks.getPartySize?.()
        if (party && plan.capacity < party) {
          return `That plan only sleeps ${plan.capacity}, but the party is ${party}. Add a room or pick larger ones.`
        }
        hooks.setRoomPlan?.(plan)
        lastPlanFirstRoomId = plan.rooms[0]?.roomId ?? null
        const names = plan.rooms
          .map((p) => `${p.quantity}x ${cat?.rooms.find((r) => r.id === p.roomId)?.name ?? p.roomId}`)
          .join(", ")
        return `Debug mode: proposed room plan ${names}, $${plan.totalPerNight}/night, sleeps ${plan.capacity}.`
      }

      case "open_booking": {
        const id = String(args.roomId ?? "") || lastPlanFirstRoomId || selectedRoomId
        const room = cat?.rooms.find((r) => r.id === id)
        return room ? `Debug mode: would open booking page for ${room.name}: ${room.book_url ?? "no URL"}.` : "Debug mode: no room selected to book."
      }

      default:
        return `Debug mode: unknown tool "${name}".`
    }
  }
}

function parseProfileUpdates(args: Record<string, unknown>): Partial<UserProfile> {
  const updates: Partial<UserProfile> = {}
  if (typeof args.firstName === "string" && args.firstName.trim()) updates.firstName = args.firstName.trim()

  const gc: Partial<GuestComposition> = {}
  if (Number.isFinite(Number(args.adults))) gc.adults = Number(args.adults)
  if (Number.isFinite(Number(args.children))) gc.children = Number(args.children)
  if (Array.isArray(args.childrenAges)) {
    gc.childrenAges = (args.childrenAges as unknown[]).map(Number).filter(Number.isFinite)
  }
  if (Object.keys(gc).length) updates.guestComposition = gc as GuestComposition

  const start = parseDate(args.startDate)
  const end = parseDate(args.endDate)
  if (start) updates.startDate = start
  if (end) updates.endDate = end
  if (Array.isArray(args.interests)) updates.interests = (args.interests as unknown[]).map(String)
  if (typeof args.travelPurpose === "string") updates.travelPurpose = args.travelPurpose
  if (typeof args.budgetRange === "string") updates.budgetRange = args.budgetRange
  if (Array.isArray(args.dietaryRestrictions)) updates.dietaryRestrictions = (args.dietaryRestrictions as unknown[]).map(String)
  if (Array.isArray(args.accessibilityNeeds)) updates.accessibilityNeeds = (args.accessibilityNeeds as unknown[]).map(String)
  return updates
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function summarizeProfile(u: Partial<UserProfile>): string {
  const bits: string[] = []
  if (u.firstName) bits.push(u.firstName)
  if (u.guestComposition) {
    const { adults, children, childrenAges } = u.guestComposition
    if (typeof adults === "number") bits.push(`${adults} adult${adults === 1 ? "" : "s"}`)
    if (typeof children === "number") bits.push(`${children} child${children === 1 ? "" : "ren"}`)
    if (childrenAges?.length) bits.push(`ages ${childrenAges.join(", ")}`)
  }
  if (u.startDate) bits.push(`from ${u.startDate.toISOString().slice(0, 10)}`)
  if (u.endDate) bits.push(`to ${u.endDate.toISOString().slice(0, 10)}`)
  if (u.travelPurpose) bits.push(u.travelPurpose)
  if (u.interests?.length) bits.push(u.interests.join(", "))
  if (u.budgetRange) bits.push(u.budgetRange)
  if (u.dietaryRestrictions?.length) bits.push(`dietary: ${u.dietaryRestrictions.join(", ")}`)
  if (u.accessibilityNeeds?.length) bits.push(`access: ${u.accessibilityNeeds.join(", ")}`)
  return bits.join("; ") || "a detail"
}

function buildRoomPlan(rawRooms: unknown): CurrentRoomPlan | null {
  const cat = getHotelCatalog(PILOT_HOTEL_SLUG)
  const raw = Array.isArray(rawRooms) ? (rawRooms as Array<Record<string, unknown>>) : []
  const rooms: CurrentRoomPlan["rooms"] = []
  let totalPerNight = 0
  let capacity = 0
  for (const item of raw) {
    const roomId = String(item.roomId ?? "")
    const quantity = Math.max(1, Math.floor(Number(item.quantity ?? 1)) || 1)
    const room = cat?.rooms.find((r) => r.id === roomId)
    if (!room) continue
    rooms.push({ roomId, quantity })
    totalPerNight += room.price * quantity
    capacity += room.occupancy * quantity
  }
  if (!rooms.length) return null
  return { rooms, totalPerNight, capacity, source: "planner" }
}

