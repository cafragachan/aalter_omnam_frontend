// Phase A.2 — tool dispatcher. Executes the model's function calls against the
// UE5 bridge, with a light validation guardrail, and returns a short string
// that becomes the function_call_output (so the model knows the result and can
// speak a natural ack). Runs client-side (needs the live useUE5Bridge instance).

import { getHotelCatalog } from "@/lib/hotel-data"
import type { useUE5Bridge } from "@/lib/ue5/bridge"
import type { SunState } from "@/components/SunToggle"
import type { UserProfile, GuestComposition } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import { PILOT_HOTEL_SLUG } from "./context"

type Ue5Bridge = ReturnType<typeof useUE5Bridge>

export interface DispatcherHooks {
  /** HUD-only: report the new scene label (does NOT inject into the LLM — the
   *  function_call_output already keeps the model aware). */
  onScene?: (label: string) => void
  /** Persist a learned profile detail to the OmnamStore (UPDATE_PROFILE). */
  saveProfile?: (updates: Partial<UserProfile>) => void
  /** Write a recommended room plan to the OmnamStore (SET_ROOM_PLAN). */
  setRoomPlan?: (plan: CurrentRoomPlan) => void
  /** Show/hide the rooms panel. */
  onRoomsPanel?: (show: boolean) => void
  /** Current party size (adults + children), for the capacity guardrail. */
  getPartySize?: () => number | undefined
}

export function createToolDispatcher(ue5: Ue5Bridge, hooks: DispatcherHooks = {}) {
  const cat = getHotelCatalog(PILOT_HOTEL_SLUG)
  // Track selection locally so we can guard view_unit (the bridge's selectedUnit
  // only reflects in-world clicks, not tool-driven select_room).
  let selectedRoomId: string | null = null
  // First room of the latest proposed plan — open_booking defaults to it.
  let lastPlanFirstRoomId: string | null = null
  // The guest starts in the virtual lounge; hotel navigation is gated until they
  // travel (startTEST). Mirrors the journey's VIRTUAL_LOUNGE → hotel transition.
  let arrived = false
  const LOUNGE_GATE = "The guest is still in the virtual lounge — call travel_to_hotel first."

  return async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "travel_to_hotel": {
        ue5.startTest() // emits { type: "startTEST", value: "startTEST" }
        arrived = true
        hooks.onScene?.("traveling to the hotel")
        return "Traveling to the property now — the hotel is coming into view."
      }

      case "save_profile": {
        const updates: Partial<UserProfile> = {}
        if (typeof args.firstName === "string" && args.firstName.trim()) {
          updates.firstName = args.firstName.trim()
        }
        const gc: Partial<GuestComposition> = {}
        if (Number.isFinite(Number(args.adults))) gc.adults = Number(args.adults)
        if (Number.isFinite(Number(args.children))) gc.children = Number(args.children)
        if (Array.isArray(args.childrenAges)) {
          gc.childrenAges = (args.childrenAges as unknown[]).map(Number).filter(Number.isFinite)
        }
        if (Object.keys(gc).length) updates.guestComposition = gc as GuestComposition
        const start = parseDate(args.startDate)
        if (start) updates.startDate = start
        const end = parseDate(args.endDate)
        if (end) updates.endDate = end
        if (Array.isArray(args.interests)) updates.interests = (args.interests as unknown[]).map(String)
        if (typeof args.travelPurpose === "string") updates.travelPurpose = args.travelPurpose
        if (typeof args.budgetRange === "string") updates.budgetRange = args.budgetRange
        if (Array.isArray(args.dietaryRestrictions)) {
          updates.dietaryRestrictions = (args.dietaryRestrictions as unknown[]).map(String)
        }
        if (Array.isArray(args.accessibilityNeeds)) {
          updates.accessibilityNeeds = (args.accessibilityNeeds as unknown[]).map(String)
        }
        if (Object.keys(updates).length === 0) return "Nothing new to remember."
        hooks.saveProfile?.(updates)
        const summary = summarizeProfile(updates)
        hooks.onScene?.(`noted: ${summary}`)
        return `Remembered: ${summary}.`
      }

      case "navigate_to": {
        if (!arrived) return LOUNGE_GATE
        const area = String(args.area ?? "")
        switch (area) {
          case "rooms":
            ue5.navigateToRooms()
            break
          case "amenities":
            ue5.navigateToAmenities()
            break
          case "location":
            ue5.navigateToLocation()
            break
          case "default":
            ue5.resetToDefault()
            break
          default:
            return `"${area}" is not a valid area (use rooms, amenities, location, or default).`
        }
        hooks.onRoomsPanel?.(area === "rooms")
        hooks.onScene?.(area)
        return `Navigated to ${area}.`
      }

      case "go_to_amenity": {
        if (!arrived) return LOUNGE_GATE
        const wanted = String(args.amenity ?? "").trim().toLowerCase()
        const match = cat?.amenities.find(
          (a) =>
            a.name.toLowerCase() === wanted ||
            a.aliases?.some((x) => x.toLowerCase() === wanted),
        )
        if (!match) {
          const describedOnly = cat?.amenitiesDescribedOnly.find(
            (a) => a.name.toLowerCase() === wanted,
          )
          if (describedOnly) {
            return `${describedOnly.name} is not part of the walkable tour yet — describe it for the guest instead of navigating.`
          }
          return `"${args.amenity}" is not a visitable amenity.`
        }
        ue5.navigateToAmenity(match.id)
        hooks.onScene?.(match.name)
        return `Walking the guest into ${match.name}.`
      }

      case "select_room": {
        if (!arrived) return LOUNGE_GATE
        const id = String(args.roomId ?? "")
        const room = cat?.rooms.find((r) => r.id === id)
        if (!room) return `"${id}" is not a known room id.`
        ue5.selectRoom(id)
        selectedRoomId = id
        hooks.onScene?.(`${room.name} (selected)`)
        return `Highlighted ${room.name} ($${room.price}/night, sleeps ${room.occupancy}).`
      }

      case "view_unit": {
        if (!arrived) return LOUNGE_GATE
        const view = String(args.view ?? "")
        if (view !== "interior" && view !== "exterior") {
          return `view must be "interior" or "exterior".`
        }
        if (view === "interior" && !selectedRoomId) {
          return `No room is selected yet — select a room first, then step inside.`
        }
        ue5.viewUnit(view)
        hooks.onScene?.(view === "interior" ? "inside the unit" : "unit exterior")
        return `Now showing the ${view}.`
      }

      case "set_lighting": {
        const mode = String(args.mode ?? "")
        if (mode !== "daylight" && mode !== "sunset" && mode !== "night") {
          return `mode must be daylight, sunset, or night.`
        }
        ue5.changeSunPosition(mode as SunState)
        hooks.onScene?.(`lighting: ${mode}`)
        return `Lighting set to ${mode}.`
      }

      case "propose_room_plan": {
        const raw = Array.isArray(args.rooms) ? (args.rooms as Array<Record<string, unknown>>) : []
        const planRooms: { roomId: string; quantity: number }[] = []
        let totalPerNight = 0
        let capacity = 0
        for (const r of raw) {
          const id = String(r.roomId ?? "")
          const qty = Math.max(1, Math.floor(Number(r.quantity ?? 1)) || 1)
          const room = cat?.rooms.find((x) => x.id === id)
          if (!room) continue
          planRooms.push({ roomId: id, quantity: qty })
          totalPerNight += room.price * qty
          capacity += room.occupancy * qty
        }
        if (!planRooms.length) return "None of those room ids exist — pick from the catalog."
        // Deterministic capacity guardrail — never propose a plan too small.
        const party = hooks.getPartySize?.()
        if (party && capacity < party) {
          return `That plan only sleeps ${capacity}, but the party is ${party}. Add a room or pick larger ones so everyone fits, then propose again.`
        }
        hooks.setRoomPlan?.({ rooms: planRooms, totalPerNight, capacity, source: "planner" })
        hooks.onRoomsPanel?.(true)
        lastPlanFirstRoomId = planRooms[0].roomId
        const names = planRooms
          .map((p) => `${p.quantity}× ${cat?.rooms.find((x) => x.id === p.roomId)?.name ?? p.roomId}`)
          .join(", ")
        return `Proposed plan: ${names} — $${totalPerNight}/night, sleeps ${capacity}.`
      }

      case "open_booking": {
        const id = String(args.roomId ?? "") || lastPlanFirstRoomId || selectedRoomId || ""
        const room = cat?.rooms.find((r) => r.id === id)
        if (!room) return "I'm not sure which room to book — let's settle on one first."
        if (!room.book_url) return `${room.name} doesn't have a booking link yet.`
        if (typeof window !== "undefined") window.open(room.book_url, "_blank", "noopener,noreferrer")
        return `Opening the booking page for ${room.name} in a new tab.`
      }

      default:
        return `Unknown tool "${name}".`
    }
  }
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
    const { adults, children } = u.guestComposition
    const parts: string[] = []
    if (typeof adults === "number") parts.push(`${adults} adult${adults === 1 ? "" : "s"}`)
    if (typeof children === "number" && children > 0) parts.push(`${children} child${children === 1 ? "" : "ren"}`)
    if (parts.length) bits.push(parts.join(" + "))
  }
  if (u.startDate) bits.push(`from ${u.startDate.toISOString().slice(0, 10)}${u.endDate ? ` to ${u.endDate.toISOString().slice(0, 10)}` : ""}`)
  if (u.interests?.length) bits.push(u.interests.join(", "))
  if (u.travelPurpose) bits.push(u.travelPurpose)
  if (u.budgetRange) bits.push(u.budgetRange)
  if (u.dietaryRestrictions?.length) bits.push(`dietary: ${u.dietaryRestrictions.join(", ")}`)
  if (u.accessibilityNeeds?.length) bits.push(`access: ${u.accessibilityNeeds.join(", ")}`)
  return bits.join("; ") || "a detail"
}
