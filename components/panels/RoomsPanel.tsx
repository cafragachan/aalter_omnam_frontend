"use client"

import { GlassPanel } from "@/components/glass-panel"
import { HotelRoomCard } from "@/components/HotelRoomCard"
import type { Room, RoomPlan } from "@/lib/hotel-data"

type RoomsPanelProps = {
  visible: boolean
  hotelName: string
  rooms: Room[]
  onClose: () => void
  /** Multi-room plan — drives the suggested-plan summary, the per-card
   * `selected` state, and the quantity rendered in each selected card. The
   * full catalog is always rendered so the guest can see alternatives. */
  recommendedPlan?: RoomPlan | null
  /** Add a room to the current plan with quantity 1. */
  onAddRoom: (roomId: string) => void
  /** Change a room's quantity in the current plan. */
  onSetRoomQuantity: (roomId: string, quantity: number) => void
  /** Remove a room from the current plan. */
  onRemoveRoom: (roomId: string) => void
}

export function RoomsPanel({
  visible,
  hotelName: _hotelName,
  rooms,
  onClose: _onClose,
  recommendedPlan,
  onAddRoom,
  onSetRoomQuantity,
  onRemoveRoom,
}: RoomsPanelProps) {
  if (!visible) return null

  // Build a lookup: roomId → quantity from the current plan.
  const planQuantities = new Map<string, number>()
  if (recommendedPlan) {
    for (const entry of recommendedPlan.entries) {
      planQuantities.set(entry.roomId, entry.quantity)
    }
  }

  // Build per-room breakdown for booking.com-style summary
  const hasAllocationPlan = recommendedPlan && recommendedPlan.entries.length > 0
  const totalRoomCount = hasAllocationPlan
    ? recommendedPlan!.entries.reduce((sum, e) => sum + e.quantity, 0)
    : 0

  return (
    <div className="pointer-events-auto h-full w-full">
      <GlassPanel className="h-full rounded-[16px] border border-white/20 bg-black/40 bg-none px-2.5 py-2.5 shadow-[0_24px_70px_-24px_rgba(0,0,0,0.95)] backdrop-blur-2xl">
        <div className="flex h-full min-h-0 flex-col gap-2">
          {hasAllocationPlan && (
            <div className="rounded-[10px] border border-white/10 bg-black/20 px-2 py-2">
              <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/50">
                Suggested plan
              </p>
              <div className="space-y-1">
                {recommendedPlan!.entries.map((entry, idx) => (
                  <div key={`${entry.roomId}-${idx}`} className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="min-w-0 truncate text-white/90">
                      {entry.quantity}x {entry.roomName}
                      {entry.guestCount != null && (
                        <span className="ml-1 text-white/50">
                          ({entry.guestCount} guest{entry.guestCount > 1 ? "s" : ""})
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-white/60">
                      ${(entry.pricePerNight * entry.quantity).toLocaleString()}/night
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-white/10 pt-1.5 text-[10px]">
                <span className="font-medium text-white/70">
                  {totalRoomCount} room{totalRoomCount > 1 ? "s" : ""} total
                </span>
                <span className="font-semibold text-white/90">
                  ${recommendedPlan!.totalPricePerNight.toLocaleString()}/night
                </span>
              </div>
            </div>
          )}

          <div className="unit-detail-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {rooms.length > 0 ? (
              rooms.map((room) => {
                const quantity = planQuantities.get(room.id)
                const selected = quantity != null
                return (
                  <HotelRoomCard
                    key={room.id}
                    room={room}
                    selected={selected}
                    quantity={quantity}
                    onSelect={() => onAddRoom(room.id)}
                    onQuantityChange={(n) => onSetRoomQuantity(room.id, n)}
                    onRemove={() => onRemoveRoom(room.id)}
                  />
                )
              })
            ) : (
              <p className="text-sm text-white/70">No rooms available for this property.</p>
            )}
          </div>
        </div>
      </GlassPanel>
    </div>
  )
}
