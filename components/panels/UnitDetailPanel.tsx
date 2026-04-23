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
    <div className="space-y-1">
      <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-white/65">{title}</p>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={`${title}-${item}`} className="text-[10px] leading-relaxed text-white/82">
            - {item}
          </li>
        ))}
      </ul>
    </div>
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
      <GlassPanel className="pointer-events-auto w-[320px] space-y-2 border border-white/15 bg-white/12 px-3.5 py-3 text-white shadow-2xl shadow-black/40 backdrop-blur-2xl">
        <div className="flex items-center justify-between">
          <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-white/70">Unit Selected</div>
          <div className="rounded-full border border-white/20 bg-white/10 px-1.5 py-0.5 text-[9px] text-white/80">
            Level {unit.level ?? "N/A"}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.2em]">{unit.roomName}</h3>
          <p className="mt-0.5 text-sm font-semibold text-white/80">{formatUnitPrice(unit.price)} /night</p>
        </div>
        <p className="text-[10px] leading-relaxed text-white/70">
          {unit.description?.trim() || "No description provided for this unit."}
        </p>

        {room && (
          <div className="max-h-[56vh] space-y-2 overflow-y-auto border-t border-white/10 pt-2 pr-1">
            {(areaText || room.roomType || (room.view && room.view.length > 0)) && (
              <div className="space-y-1">
                <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-white/65">Room Details</p>
                {areaText && <p className="text-[10px] text-white/82">Area: {areaText}</p>}
                {room.roomType && <p className="text-[10px] text-white/82">Type: {room.roomType}</p>}
                {room.view && room.view.length > 0 && (
                  <p className="text-[10px] text-white/82">View: {room.view.join(", ")}</p>
                )}
              </div>
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
