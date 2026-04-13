"use client"

// Stage 5 of the HeyGen → LiveKit migration.
//
// Agent → client tool-call bridge. Subscribes to `tool_call` data-channel
// messages (forwarded from `agent/tools.ts`) and translates each into
// either an EventBus emit or a page-level callback so the existing
// orchestration (useJourney, panels, UE5 bridge) handles them exactly
// as if they were direct UI interactions.
//
// Design notes:
//   - The bridge is a pure consumer of the agent-side tool catalog.
//     Tool name + arg shape must match `agent/tools.ts` — keep these
//     two files in sync by hand (same discipline as data-channel.ts).
//   - For tools that map to existing EventBus events, we emit instead
//     of calling callbacks directly so useJourney picks them up through
//     its existing useEventListener subscriptions. This avoids special
//     case paths in useJourney.
//   - For `open_rooms_panel` / `open_amenities_panel` / `open_location_panel`
//     we call a page-level `onOpenPanel` callback because that's the
//     same shape useJourney's own OPEN_PANEL effect uses — keeping the
//     app/home-v2/page.tsx wiring symmetric with app/home/page.tsx.
//   - Unknown tools are logged and ignored — never throw from the
//     handler because that kills the subscription.
//
// SCOPE LOCK (Stage 5):
//   - Reads from useLiveKitAvatarContext for subscribeToToolCalls
//     (provider API added in Stage 3 for exactly this purpose).
//   - Uses lib/hotel-data lookup helpers to resolve room/amenity IDs
//     into full payloads that EventBus consumers expect.
//   - Does not render anything, does not publish outbound messages.

import { useEffect } from "react"

import { useEmit } from "@/lib/events"
import {
  getAmenitiesByHotelId,
  getHotelBySlug,
  getRoomsByHotelId,
} from "@/lib/hotel-data"

import { useLiveKitAvatarContext } from "./context"

// ---------------------------------------------------------------------
// Tool arg shapes — kept in sync with agent/tools.ts by hand.
// ---------------------------------------------------------------------

type ToolCallName =
  | "open_rooms_panel"
  | "open_amenities_panel"
  | "open_location_panel"
  | "select_hotel"
  | "select_room"
  | "navigate_to_amenity"
  | "view_unit"
  | "navigate_back"
  | "end_experience"
  | "open_test_panel" // kept for Stage 2 debugging

type ToolCallArgs = Record<string, unknown>

// ---------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------

type UseToolCallBridgeOptions = {
  /** Disable the bridge (no-op). Defaults to true. */
  enabled?: boolean

  /**
   * Open a UI panel. Mirrors useJourney's OPEN_PANEL effect consumer
   * in the home page — pass the same handler the page uses for
   * useJourney's onOpenPanel option.
   */
  onOpenPanel: (panel: "rooms" | "amenities" | "location") => void

  /**
   * End-of-experience callback. Should trigger the journey reducer's
   * END_EXPERIENCE path. The page wires this to
   * journeyDispatch({type:"USER_INTENT", intent:{type:"END_EXPERIENCE"}})
   * so the existing reducer + farewell flow handles the rest.
   */
  onEndExperience: () => void

  /**
   * Currently-selected hotel slug, used to resolve room/amenity IDs
   * to full payloads for EventBus emits. Null before hotel selection.
   */
  selectedHotelSlug: string | null
}

// ---------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------

export function useToolCallBridge(options: UseToolCallBridgeOptions): void {
  const { enabled = true, onOpenPanel, onEndExperience, selectedHotelSlug } = options

  const { subscribeToToolCalls } = useLiveKitAvatarContext()
  const emit = useEmit()

  useEffect(() => {
    if (!enabled) return

    const handleToolCall = (msg: {
      type: "tool_call"
      name: string
      args: ToolCallArgs
    }) => {
      const name = msg.name as ToolCallName
      const args = msg.args ?? {}

      try {
        switch (name) {
          case "open_rooms_panel": {
            onOpenPanel("rooms")
            emit({ type: "PANEL_REQUESTED", panel: "rooms" })
            return
          }

          case "open_amenities_panel": {
            onOpenPanel("amenities")
            emit({ type: "PANEL_REQUESTED", panel: "amenities" })
            return
          }

          case "open_location_panel": {
            onOpenPanel("location")
            emit({ type: "PANEL_REQUESTED", panel: "location" })
            return
          }

          case "select_hotel": {
            const slug = typeof args.slug === "string" ? args.slug : null
            if (!slug) {
              console.warn("[tool-bridge] select_hotel missing slug arg:", args)
              return
            }
            const hotel = getHotelBySlug(slug)
            if (!hotel) {
              console.warn(
                `[tool-bridge] select_hotel: unknown slug "${slug}" — ignoring`,
              )
              return
            }
            emit({ type: "HOTEL_SELECTED", slug: hotel.slug })
            return
          }

          case "select_room": {
            // Accept either roomId (canonical) or roomName (fuzzy).
            const roomIdArg = typeof args.roomId === "string" ? args.roomId : null
            const roomNameArg =
              typeof args.roomName === "string" ? args.roomName : null

            if (!selectedHotelSlug) {
              console.warn(
                "[tool-bridge] select_room fired before hotel selection — ignoring",
              )
              return
            }
            const hotel = getHotelBySlug(selectedHotelSlug)
            if (!hotel) {
              console.warn(
                `[tool-bridge] select_room: no hotel for slug "${selectedHotelSlug}"`,
              )
              return
            }
            const rooms = getRoomsByHotelId(hotel.id)
            const room =
              (roomIdArg && rooms.find((r) => r.id === roomIdArg)) ||
              (roomNameArg &&
                rooms.find(
                  (r) => r.name.toLowerCase() === roomNameArg.toLowerCase(),
                )) ||
              (roomNameArg &&
                rooms.find((r) =>
                  r.name.toLowerCase().includes(roomNameArg.toLowerCase()),
                )) ||
              null
            if (!room) {
              console.warn(
                `[tool-bridge] select_room: no match for roomId=${roomIdArg}, roomName=${roomNameArg}`,
              )
              return
            }
            emit({
              type: "ROOM_CARD_TAPPED",
              roomId: room.id,
              roomName: room.name,
              occupancy: room.occupancy,
            })
            return
          }

          case "navigate_to_amenity": {
            const amenityNameArg =
              typeof args.amenityName === "string" ? args.amenityName : null
            if (!selectedHotelSlug || !amenityNameArg) {
              console.warn(
                "[tool-bridge] navigate_to_amenity missing inputs:",
                { selectedHotelSlug, args },
              )
              return
            }
            const hotel = getHotelBySlug(selectedHotelSlug)
            if (!hotel) return
            const amenities = getAmenitiesByHotelId(hotel.id)
            const needle = amenityNameArg.toLowerCase()
            const match =
              amenities.find((a) => a.name.toLowerCase() === needle) ||
              amenities.find((a) => a.name.toLowerCase().includes(needle)) ||
              amenities.find((a) => a.scene.toLowerCase().includes(needle)) ||
              null
            if (!match) {
              console.warn(
                `[tool-bridge] navigate_to_amenity: no match for "${amenityNameArg}"`,
              )
              return
            }
            emit({
              type: "AMENITY_CARD_TAPPED",
              amenityId: match.id,
              name: match.name,
              scene: match.scene,
            })
            return
          }

          case "view_unit": {
            const mode =
              args.mode === "interior" || args.mode === "exterior"
                ? args.mode
                : null
            if (!mode) {
              console.warn("[tool-bridge] view_unit: invalid mode arg:", args)
              return
            }
            emit({ type: "VIEW_CHANGE", view: mode })
            return
          }

          case "navigate_back": {
            emit({ type: "NAVIGATE_BACK" })
            return
          }

          case "end_experience": {
            onEndExperience()
            return
          }

          case "open_test_panel": {
            // Stage 2 debug tool — still wired so the /livekit-test
            // page keeps working. Translate to a rooms-panel open if
            // the agent asked for "rooms", otherwise ignore.
            const panel = args.panel
            if (panel === "rooms" || panel === "amenities" || panel === "location") {
              onOpenPanel(panel)
            } else {
              console.warn("[tool-bridge] open_test_panel: invalid panel arg:", args)
            }
            return
          }

          default: {
            console.warn(`[tool-bridge] unknown tool "${name}" — ignoring`, args)
          }
        }
      } catch (err) {
        console.error(`[tool-bridge] handler for "${name}" threw:`, err)
      }
    }

    const unsubscribe = subscribeToToolCalls(handleToolCall)
    return unsubscribe
  }, [enabled, subscribeToToolCalls, emit, onOpenPanel, onEndExperience, selectedHotelSlug])
}
