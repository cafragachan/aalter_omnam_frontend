"use client"

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
  if (!unit) return null

  const areaText = room?.area?.label
    ? room.area.label
    : room?.area
      ? `${room.area.min_sqm}-${room.area.max_sqm} SQM`
      : null

  return (
    <div className="fixed right-4 top-1/2 z-20 -translate-y-1/2">
      <GlassPanel className="pointer-events-auto w-[340px] space-y-3 border border-white/15 bg-white/12 px-4 py-3.5 text-white shadow-2xl shadow-black/40 backdrop-blur-2xl">
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

        <div className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2">
          <p className="text-[10px] leading-relaxed text-white/75">
            {unit.description?.trim() || "No description provided for this unit."}
          </p>
        </div>

        {room && (
          <div className="unit-detail-scroll max-h-[54vh] space-y-3 overflow-y-auto border-t border-white/10 pt-3 pr-2">
            {(areaText || room.roomType || (room.view && room.view.length > 0)) && (
              <section className="space-y-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2.5">
                <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/65">Room Details</p>
                {areaText && <p className="text-[10px] text-white/85">Area: {areaText}</p>}
                {room.roomType && <p className="text-[10px] text-white/85">Type: {room.roomType}</p>}
                {room.view && room.view.length > 0 && (
                  <p className="text-[10px] text-white/85">View: {room.view.join(", ")}</p>
                )}
              </section>
            )}

            {renderList("Features", room.features)}
            {renderList("Bedding", room.bedding)}
            {renderList("Bath", room.bath)}
            {renderList("Tech", room.tech)}
            {renderList("Services", room.services)}
          </div>
        )}
      </GlassPanel>
    </div>
  )
}
