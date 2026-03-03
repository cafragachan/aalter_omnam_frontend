"use client"

import { GlassPanel } from "@/components/glass-panel"
import type { UnitSelectionMessage } from "@/lib/useUE5WebSocket"

type UnitDetailPanelProps = {
  unit: UnitSelectionMessage | null
}

function formatUnitPrice(price?: string) {
  if (!price) return "N/A"
  const parsed = Number(price)
  if (Number.isFinite(parsed)) {
    return `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  }
  return price
}

export function UnitDetailPanel({ unit }: UnitDetailPanelProps) {
  if (!unit) return null

  return (
    <div className="pointer-events-none fixed right-6 top-1/2 z-20 -translate-y-1/2">
      <GlassPanel className="pointer-events-auto w-[360px] space-y-4 border border-white/15 bg-white/12 px-7 py-6 text-white shadow-2xl shadow-black/40 backdrop-blur-2xl">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">Unit Selected</div>
          <div className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs text-white/80">
            Level {unit.level ?? "N/A"}
          </div>
        </div>
        <div>
          <h3 className="text-xl font-semibold uppercase tracking-[0.2em]">{unit.roomName}</h3>
          <p className="mt-1 text-lg font-semibold text-white/80">{formatUnitPrice(unit.price)} /night</p>
        </div>
        <p className="text-xs leading-relaxed text-white/70">
          {unit.description?.trim() || "No description provided for this unit."}
        </p>
      </GlassPanel>
    </div>
  )
}
