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
        "Step the guest INTO (interior) or OUT OF (exterior) the room they have selected. Only valid after a room is selected.",
      parameters: {
        type: "object",
        properties: { view: { type: "string", enum: ["interior", "exterior"] } },
        required: ["view"],
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
      name: "select_room",
      description: `Highlight/focus a specific room type in the scene. Room ids: ${roomLabels}.`,
      parameters: {
        type: "object",
        properties: { roomId: { type: "string", enum: roomIds } },
        required: ["roomId"],
      },
    })
  }

  return tools
}
