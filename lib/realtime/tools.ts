// Phase A.2 — function-calling tool schemas for the realtime brain.
//
// These map ~1:1 onto the UE5 bridge commands (see lib/realtime/dispatcher.ts
// for execution). Enums are sourced from the live catalog so the model can only
// name real amenities / rooms. Built server-side and baked into the realtime
// ephemeral token (app/api/realtime-token) alongside the L1 instruction.

import { getHotelCatalog } from "@/lib/hotel-data"
import { PILOT_HOTEL_SLUG } from "./context"

export interface RealtimeTool {
  type: "function"
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function buildToolSchemas(slug: string = PILOT_HOTEL_SLUG): RealtimeTool[] {
  const cat = getHotelCatalog(slug)
  const amenityNames = cat?.tools.amenityNames ?? []
  const roomIds = cat?.rooms.map((r) => r.id) ?? []
  const roomLabels = cat?.rooms.map((r) => `${r.id} = ${r.name}`).join(", ") ?? ""

  const tools: RealtimeTool[] = [
    {
      type: "function",
      name: "travel_to_hotel",
      description:
        "Take the guest from the virtual lounge to the hotel/property. Call this once you've learned a little about their trip, or whenever they ask to see the hotel. REQUIRED before any room/amenity navigation.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      type: "function",
      name: "return_to_lounge",
      description:
        "Take the guest back to the virtual lounge — the experience's landing space. Call this whenever they ask to go back to the lounge, home, or the start.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      type: "function",
      name: "save_profile",
      description:
        "Quietly remember a detail the guest shares about their trip, so you can tailor the tour and recommendations. Call this whenever you learn something new (multiple times is fine). Include ONLY the fields you actually learned this turn — never guess.",
      parameters: {
        type: "object",
        properties: {
          firstName: { type: "string" },
          adults: { type: "integer", description: "number of adults in the party" },
          children: { type: "integer", description: "number of children in the party" },
          childrenAges: { type: "array", items: { type: "integer" } },
          startDate: { type: "string", description: "check-in date as ISO YYYY-MM-DD, if known" },
          endDate: { type: "string", description: "check-out date as ISO YYYY-MM-DD, if known" },
          interests: {
            type: "array",
            items: { type: "string" },
            description: "what they care about, e.g. spa, fine dining, romance, hiking, lake views",
          },
          travelPurpose: { type: "string", description: "e.g. honeymoon, family vacation, business" },
          budgetRange: { type: "string" },
          dietaryRestrictions: { type: "array", items: { type: "string" } },
          accessibilityNeeds: { type: "array", items: { type: "string" } },
        },
        required: [],
      },
    },
    {
      type: "function",
      name: "navigate_to",
      description:
        "Move the guest to a top-level area of the live 3D tour. Call this when they ask to see rooms, amenities, the surroundings/location, or to go back to the default view.",
      parameters: {
        type: "object",
        properties: {
          area: { type: "string", enum: ["rooms", "amenities", "location", "default"] },
        },
        required: ["area"],
      },
    },
    {
      type: "function",
      name: "set_lighting",
      description: "Change the time-of-day lighting of the scene.",
      parameters: {
        type: "object",
        properties: { mode: { type: "string", enum: ["daylight", "sunset", "night"] } },
        required: ["mode"],
      },
    },
    {
      type: "function",
      name: "view_unit",
      description:
        "Step the guest INTO (interior) or OUT OF (exterior) the room they have selected. Only valid after a room/unit is selected. Pass unitId to focus a specific physical unit first.",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", enum: ["interior", "exterior"] },
          unitId: { type: "integer", description: "optional: focus this unit first" },
        },
        required: ["view"],
      },
    },
    {
      type: "function",
      name: "show_points_of_interest",
      description:
        "When the guest is exploring the surrounding area, drop map markers for notable nearby places. Pass a category of place to show.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "e.g. fine dining, landmarks, lakeside towns, bars, activities" },
        },
        required: ["category"],
      },
    },
    {
      type: "function",
      name: "open_booking",
      description:
        "Open the booking/reservation page for a room in a new tab when the guest is ready to book. Omit roomId to book the first room in the current proposed plan.",
      parameters: {
        type: "object",
        properties: { roomId: { type: "string" } },
        required: [],
      },
    },
  ]

  if (amenityNames.length) {
    tools.push({
      type: "function",
      name: "go_to_amenity",
      description:
        "Walk the guest into a specific visitable amenity space. Only the listed amenities are part of the walkable tour.",
      parameters: {
        type: "object",
        properties: { amenity: { type: "string", enum: amenityNames } },
        required: ["amenity"],
      },
    })
  }

  if (roomIds.length) {
    tools.push({
      type: "function",
      name: "propose_room_plan",
      description: `Recommend a specific set of rooms for the guest's stay — highlights them in the scene and shows them in the rooms panel. Use what you know about their party, dates, taste, and budget; make sure total capacity fits the party. Room ids: ${roomLabels}.`,
      parameters: {
        type: "object",
        properties: {
          rooms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                roomId: { type: "string", enum: roomIds },
                quantity: { type: "integer" },
              },
              required: ["roomId", "quantity"],
            },
          },
        },
        required: ["rooms"],
      },
    })
    // Unit ids arrive at runtime (UE5 pushes the inventory after the token is
    // baked), so they can't be enum-constrained — accept free-form integers and
    // validate against the live inventory in the dispatcher.
    tools.push({
      type: "function",
      name: "select_units",
      description:
        "Select/highlight specific physical units by their numeric ids (from the unit inventory). " +
        "Use when the guest names units by floor/view/position, e.g. 'the top-floor lake-view one'. " +
        "Only ever pass AVAILABLE units (the inventory marks each avail/booked) — never select a booked unit. " +
        "Respects the room plan's per-type quantities (extra picks of a full type replace the oldest).",
      parameters: {
        type: "object",
        properties: { unitIds: { type: "array", items: { type: "integer" } } },
        required: ["unitIds"],
      },
    })
  }

  return tools
}
