"use client"

import { Trash2 } from "lucide-react"
import { Card } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Room } from "@/lib/hotel-data"

const QUANTITY_OPTIONS = [1, 2, 3, 4, 5]

interface HotelRoomCardProps {
  room: Room
  /** True when this room is in the current room plan. */
  selected: boolean
  /** How many of this room type are in the plan. Required when `selected` is true. */
  quantity?: number
  /** Add this room to the plan with quantity 1. */
  onSelect: () => void
  /** Update this room's quantity in the plan. */
  onQuantityChange: (quantity: number) => void
  /** Drop this room from the plan. */
  onRemove: () => void
}

export function HotelRoomCard({
  room,
  selected,
  quantity,
  onSelect,
  onQuantityChange,
  onRemove,
}: HotelRoomCardProps) {
  const descriptionParts = [room.roomType, room.area?.label, room.view?.[0]].filter(Boolean) as string[]
  const description = descriptionParts.length > 0 ? descriptionParts.join(" | ") : "Curated room experience"

  return (
    <Card
      className={`group w-full gap-0 overflow-hidden rounded-[10px] border bg-black/35 py-0 shadow-[0_20px_48px_-30px_rgba(0,0,0,0.95)] backdrop-blur-xl ${selected ? "border-white/85 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.75),0_20px_48px_-30px_rgba(0,0,0,0.95)]" : "border-white/20"}`}
    >
      <div className="flex w-full">
        <div className="relative aspect-[4/3] basis-2/5 overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
          {/* Pill toggle — visual indicator only. The bottom-row controls are
              the click targets (matches the Booking.com reference; see plan
              for v1 rationale). */}
          <div
            className={`absolute left-1.5 top-1.5 z-10 size-3.5 rounded-full border ${selected ? "border-white bg-white" : "border-white/70 bg-transparent"}`}
            aria-hidden="true"
          />
          <img
            src={room.image}
            alt={room.name}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-black/25" />
        </div>

        <div className="flex min-w-0 basis-3/5 flex-col gap-1.5 p-2.5">
          <div className="space-y-0.5">
            <h3 className="truncate text-[11px] font-semibold text-white">{room.name}</h3>
            <p className="line-clamp-2 text-[10px] leading-snug text-white/65">{description}</p>
          </div>

          <div className="space-y-0.5">
            <p className="text-[10px] text-white/65">Occupancy: {room.occupancy}</p>
            <p className="text-[11px] font-semibold text-white">${room.price.toLocaleString()}/night</p>
          </div>

          {selected ? (
            <div className="flex items-center gap-1.5">
              {/* Quantity dropdown — Radix Select styled so the popup feels
                  like the trigger pill expanding downward: trigger's bottom
                  corners square off + popup's top corners square off when
                  open, and the popup sits flush (`translate-y-0`) instead of
                  the default 1-unit offset. */}
              <Select
                value={String(quantity ?? 1)}
                onValueChange={(v) => onQuantityChange(parseInt(v, 10))}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={`${room.name} quantity`}
                  className="h-7 flex-1 rounded-md border-white/30 bg-white/15 px-2 py-0 text-[10px] font-medium text-white shadow-none transition hover:bg-white/25 focus-visible:ring-0 data-[placeholder]:text-white [&_svg:not([class*='text-'])]:text-white/80 data-[state=open]:rounded-b-none data-[state=open]:border-b-transparent"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  sideOffset={0}
                  className="min-w-[var(--radix-select-trigger-width)] rounded-md rounded-t-none border-white/30 border-t-transparent bg-neutral-900/95 p-0 text-white shadow-[0_18px_45px_-28px_rgba(0,0,0,0.8)] backdrop-blur-2xl data-[side=bottom]:translate-y-0 data-[side=top]:translate-y-0"
                >
                  {QUANTITY_OPTIONS.map((n) => (
                    <SelectItem
                      key={n}
                      value={String(n)}
                      className="cursor-pointer rounded-none py-1 pr-2 pl-2 text-[10px] text-white focus:bg-white/15 focus:text-white [&>span:first-child]:hidden"
                    >
                      {n} unit{n > 1 ? "s" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                aria-label={`Remove ${room.name}`}
                onClick={onRemove}
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/25 bg-white/10 text-white/80 transition hover:border-rose-300/60 hover:bg-rose-500/20 hover:text-rose-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSelect}
              className="w-full rounded-md border border-white/40 bg-white/85 px-2 py-1 text-[10px] font-semibold text-slate-900 shadow-[0_8px_24px_-14px_rgba(0,0,0,0.6)] transition hover:bg-white"
            >
              Select
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}
