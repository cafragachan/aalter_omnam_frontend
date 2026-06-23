"use client"

import type { UserProfile } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import type { UnitInventoryEntry } from "@/lib/selection"
import {
  bookingRoomFromPlan,
  buildRoomPlan,
  parseProfileUpdates,
  summarizeProfile,
  summarizeRoomPlan,
  validatePlanCapacity,
  validateUnitSelection,
} from "@/lib/agent-runtime/tool-core"
import { makeDebugEvent, type DebugEvent } from "./types"

export type DebugToolDispatcherHooks = {
  saveProfile?: (updates: Partial<UserProfile>) => void
  setRoomPlan?: (plan: CurrentRoomPlan) => void
  addEvent?: (event: DebugEvent) => void
  getPartySize?: () => number | undefined
  getInventory?: () => UnitInventoryEntry[]
  selectUnits?: (unitIds: number[]) => void
  setActiveUnit?: (unitId: number) => void
  hasExplicitPick?: () => boolean
  getPlan?: () => CurrentRoomPlan | null
}

export function createDebugToolDispatcher(hooks: DebugToolDispatcherHooks = {}) {
  let arrived = false
  let currentPlan: CurrentRoomPlan | null = null
  let lastPlanFirstRoomId: string | null = null
  let explicitPick = false

  const getPlan = () => hooks.getPlan?.() ?? currentPlan
  const hasExplicitPick = () => hooks.hasExplicitPick?.() ?? explicitPick

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
        return "Debug mode: marked the guest as arrived at EDITION Lake Como. Offer rooms, amenities, or the surrounding area; recommend rooms only when the guest asks."
      }

      case "return_to_lounge": {
        arrived = false
        return "Debug mode: marked the guest as returned to the virtual lounge."
      }

      case "navigate_to": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        const area = String(args.area ?? "")
        if (!["rooms", "amenities", "location", "default"].includes(area)) {
          return `"${area}" is not a valid area (use rooms, amenities, location, or default).`
        }
        return `Debug mode: would navigate to ${area}.`
      }

      case "go_to_amenity": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        return `Debug mode: would walk the guest to ${String(args.amenity ?? "that amenity")}.`
      }

      case "show_points_of_interest": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        return `Debug mode: would map nearby ${String(args.category ?? "points of interest")}.`
      }

      case "set_lighting": {
        return `Debug mode: would set lighting to ${String(args.mode ?? "unknown")}.`
      }

      case "propose_room_plan": {
        const plan = buildRoomPlan(args.rooms)
        if (!plan) return "None of those room ids exist. Pick from the catalog."
        const capacityError = validatePlanCapacity(plan, hooks.getPartySize?.())
        if (capacityError) return capacityError
        currentPlan = plan
        explicitPick = false
        hooks.setRoomPlan?.(plan)
        lastPlanFirstRoomId = plan.rooms[0]?.roomId ?? null
        return `Debug mode: proposed room plan ${summarizeRoomPlan(plan)}, $${plan.totalPerNight}/night, sleeps ${plan.capacity}.`
      }

      case "select_units": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        const inventory = hooks.getInventory?.() ?? []
        if (!inventory.length) return "Debug mode: no unit inventory is loaded, so physical unit selection cannot be validated."
        const selection = validateUnitSelection(args, inventory, getPlan())
        if (!selection.ok) return selection.message
        explicitPick = true
        hooks.selectUnits?.(selection.unitIds)
        return `Debug mode: ${selection.message}`
      }

      case "view_unit": {
        if (!arrived) return "Debug mode: guest is still in the lounge. Call travel_to_hotel first."
        const view = String(args.view ?? "")
        if (view !== "interior" && view !== "exterior") return `view must be "interior" or "exterior".`
        if (typeof args.unitId === "number") {
          explicitPick = true
          hooks.setActiveUnit?.(args.unitId)
          return `Debug mode: would focus unit ${args.unitId} and show its ${view}.`
        }
        if (view === "interior" && !hasExplicitPick()) {
          return "No unit picked yet. Invite the guest to tap one of the available units, or name a specific unit, then step inside."
        }
        return `Debug mode: would show the selected unit's ${view}.`
      }

      case "open_booking": {
        const room = bookingRoomFromPlan(args, getPlan(), lastPlanFirstRoomId)
        return room ? `Debug mode: would open booking page for ${room.name}: ${room.book_url ?? "no URL"}.` : "I'm not sure which room to book. Let's settle on one first."
      }

      default:
        return `Debug mode: unknown tool "${name}".`
    }
  }
}
