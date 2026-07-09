"use client"

import { useEffect, useState } from "react"
import { ChevronDown, Maximize2, Users } from "lucide-react"

import { GlassPanel } from "@/components/glass-panel"
import type { UnitSelectionMessage } from "@/lib/useUE5WebSocket"
import type { Room } from "@/lib/hotel-data"

type UnitDetailPanelProps = {
  unit: UnitSelectionMessage | null
  room?: Room | null
}

function formatUnitPrice(price?: string) {
  if (!price) return "N/A"
  const parsed = Number(price)
  if (Number.isFinite(parsed)) {
    return `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  }
  return price
}

function formatOccupancy(occupancy?: string) {
  if (!occupancy) return null
  const parsed = parseInt(occupancy, 10)
  if (Number.isFinite(parsed) && parsed > 0) {
    return `${parsed} ${parsed === 1 ? "guest" : "guests"}`
  }
  return occupancy
}

function renderList(title: string, items?: string[]) {
  if (!items || items.length === 0) return null
  return (
    <section className="space-y-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2.5">
      <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/65">{title}</p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={`${title}-${item}`} className="flex gap-2 text-[10px] leading-relaxed text-white/85">
            <span aria-hidden className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-white/55" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function UnitDetailPanel({ unit, room }: UnitDetailPanelProps) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [unit?.roomName, room?.id])

  if (!unit) return null

  const areaText = room?.area?.label
    ? room.area.label
    : room?.area
      ? `${room.area.min_sqm}-${room.area.max_sqm} SQM`
      : null
  const occupancyText = formatOccupancy(room?.occupancy)
  const description = unit.description?.trim()

  const hasRoomDetails = Boolean(room?.roomType || (room?.view && room.view.length > 0))
  const hasExpandableContent =
    Boolean(description) ||
    hasRoomDetails ||
    Boolean(room?.features?.length) ||
    Boolean(room?.bedding?.length) ||
    Boolean(room?.bath?.length) ||
    Boolean(room?.tech?.length) ||
    Boolean(room?.services?.length)

  return (
    <div className="fixed right-4 top-1/2 z-20 -translate-y-1/2">
      <GlassPanel className="pointer-events-auto w-[340px] space-y-3 border border-white/20 bg-black/40 bg-none px-4 py-3.5 text-white shadow-2xl shadow-black/40 backdrop-blur-2xl">
        <div className="flex items-center justify-between">
          <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/70">Unit Selected</div>
          <div className="rounded-full border border-white/20 bg-white/10 px-1.5 py-0.5 text-[9px] text-white/80">
            Level {unit.level ?? "N/A"}
          </div>
        </div>

        <div className="space-y-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em]">{unit.roomName}</h3>
          <p className="text-sm font-semibold text-white/85">{formatUnitPrice(unit.price)} /night</p>
        </div>

        {(occupancyText || areaText) && (
          <div className="flex items-center gap-2">
            {occupancyText && (
              <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[10px] text-white/85">
                <Users aria-hidden className="h-3 w-3 text-white/65" />
                <span>{occupancyText}</span>
              </div>
            )}
            {areaText && (
              <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[10px] text-white/85">
                <Maximize2 aria-hidden className="h-3 w-3 text-white/65" />
                <span>{areaText}</span>
              </div>
            )}
          </div>
        )}

        {hasExpandableContent && (
          <div className="space-y-2 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              aria-controls="unit-detail-expanded"
              className="flex w-full items-center justify-between rounded-lg px-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-white/75 transition hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
            >
              <span>Details</span>
              <ChevronDown
                aria-hidden
                className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
              />
            </button>

            {expanded && (
              <div
                id="unit-detail-expanded"
                className="unit-detail-scroll max-h-[54vh] space-y-3 overflow-y-auto pr-2"
              >
                {description && (
                  <div className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2">
                    <p className="text-[10px] leading-relaxed text-white/75">{description}</p>
                  </div>
                )}

                {room && hasRoomDetails && (
                  <section className="space-y-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2.5">
                    <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/65">Room Details</p>
                    {room.roomType && <p className="text-[10px] text-white/85">Type: {room.roomType}</p>}
                    {room.view && room.view.length > 0 && (
                      <p className="text-[10px] text-white/85">View: {room.view.join(", ")}</p>
                    )}
                  </section>
                )}

                {room && (
                  <>
                    {renderList("Features", room.features)}
                    {renderList("Bedding", room.bedding)}
                    {renderList("Bath", room.bath)}
                    {renderList("Tech", room.tech)}
                    {renderList("Services", room.services)}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </GlassPanel>
    </div>
  )
}
