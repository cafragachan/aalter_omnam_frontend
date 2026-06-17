// Context builders for the realtime brain.
//
// L1 (this file's buildL1Instruction): persona + a DISTILLED, semantic-only
// property dossier. Built ONCE and baked into the realtime ephemeral token —
// it is the only "large" payload and it is paid a single time per session,
// not rebuilt every turn (the old /api/orchestrate mega-prompt is gone).
//
// L3 (formatSceneDelta): a tiny one-liner injected as a conversation item when
// the scene changes, so Ava always knows where the guest is. (~15 tokens.)

import { getHotelCatalog, type HotelCatalog } from "@/lib/hotel-data"
import { CONCIERGE_PERSONA } from "./persona"

// Only active hotel for now (decision #5). When multi-hotel lands, switch to
// retrieval-on-demand rather than embedding more dossiers here.
export const PILOT_HOTEL_SLUG = "edition-lake-como"

export function buildL1Instruction(slug: string = PILOT_HOTEL_SLUG): string {
  const cat = getHotelCatalog(slug)
  if (!cat) return CONCIERGE_PERSONA
  return [
    CONCIERGE_PERSONA,
    "",
    "=== PROPERTY DOSSIER (your single source of truth) ===",
    renderHotel(cat),
    "",
    "ROOMS (you may quote these names, prices, and capacities exactly):",
    ...cat.rooms.map(renderRoom),
    "",
    "AMENITIES YOU CAN WALK THE GUEST TO:",
    ...cat.amenities.map(renderAmenity),
    ...(cat.amenitiesDescribedOnly.length
      ? [
          "",
          "AMENITIES YOU MAY DESCRIBE BUT CANNOT VISIT YET:",
          ...cat.amenitiesDescribedOnly.map(renderDescribedOnly),
        ]
      : []),
  ].join("\n")
}

function renderHotel(cat: HotelCatalog): string {
  const parts = [`${cat.hotelName} — ${cat.hotelLocation}.`]
  if (cat.hotelTagline) parts.push(cat.hotelTagline)
  if (cat.hotelDescription) parts.push(cat.hotelDescription)
  if (cat.hotelHighlights?.length) parts.push(`Highlights: ${cat.hotelHighlights.join("; ")}.`)
  return parts.join(" ")
}

function renderRoom(r: HotelCatalog["rooms"][number]): string {
  const bits: string[] = []
  if (r.roomType) bits.push(r.roomType)
  if (r.view?.length) bits.push(`${r.view.join(" / ")} view`)
  if (r.features?.length) bits.push(r.features.slice(0, 2).join(", "))
  const tail = bits.length ? ` — ${bits.join("; ")}` : ""
  return `- ${r.name} (id ${r.id}): sleeps ${r.occupancy}, $${r.price}/night${tail}.`
}

function renderAmenity(a: HotelCatalog["amenities"][number]): string {
  const desc = a.shortDescription || a.description || ""
  const cat = a.category ? ` [${a.category}]` : ""
  return `- ${a.name}${cat}: ${desc}`.trim()
}

function renderDescribedOnly(a: HotelCatalog["amenitiesDescribedOnly"][number]): string {
  const desc = a.shortDescription || a.description || ""
  return `- ${a.name}: ${desc}`.trim()
}

/** L3 — situational delta injected when the scene changes. */
export function formatSceneDelta(scene: string): string {
  return `[context] The guest is now viewing: ${scene}.`
}
