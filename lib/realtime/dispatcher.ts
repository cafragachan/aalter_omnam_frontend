// Phase A.2 — tool dispatcher. Executes the model's function calls against the
// UE5 bridge, with a light validation guardrail, and returns a short string
// that becomes the function_call_output (so the model knows the result and can
// speak a natural ack). Runs client-side (needs the live useUE5Bridge instance).

import { getHotelCatalog } from "@/lib/hotel-data"
import type { useUE5Bridge } from "@/lib/ue5/bridge"
import type { SunState } from "@/components/SunToggle"
import { PILOT_HOTEL_SLUG } from "./context"

type Ue5Bridge = ReturnType<typeof useUE5Bridge>

export interface DispatcherHooks {
  /** HUD-only: report the new scene label (does NOT inject into the LLM — the
   *  function_call_output already keeps the model aware). */
  onScene?: (label: string) => void
}

export function createToolDispatcher(ue5: Ue5Bridge, hooks: DispatcherHooks = {}) {
  const cat = getHotelCatalog(PILOT_HOTEL_SLUG)
  // Track selection locally so we can guard view_unit (the bridge's selectedUnit
  // only reflects in-world clicks, not tool-driven select_room).
  let selectedRoomId: string | null = null

  return async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "navigate_to": {
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
        hooks.onScene?.(area)
        return `Navigated to ${area}.`
      }

      case "go_to_amenity": {
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
        const id = String(args.roomId ?? "")
        const room = cat?.rooms.find((r) => r.id === id)
        if (!room) return `"${id}" is not a known room id.`
        ue5.selectRoom(id)
        selectedRoomId = id
        hooks.onScene?.(`${room.name} (selected)`)
        return `Highlighted ${room.name} ($${room.price}/night, sleeps ${room.occupancy}).`
      }

      case "view_unit": {
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

      default:
        return `Unknown tool "${name}".`
    }
  }
}
