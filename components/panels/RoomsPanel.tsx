"use client"

import { ArrowLeft } from "lucide-react"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { HotelRoomCard } from "@/components/HotelRoomCard"
import type { Room, RoomPlan } from "@/lib/hotel-data"

type RoomsPanelProps = {
  visible: boolean
  hotelName: string
  rooms: Room[]
  onSelectRoom: (room: Room) => void
  onClose: () => void
  /** @deprecated Use recommendedPlan instead */
  recommendedRoomId?: string | null
  /** Multi-room recommendation plan — drives highlight + quantity badge. The
   * full catalog is always rendered so the guest can see alternatives; rooms
   * in the plan get a highlighted border and optional quantity badge. */
  recommendedPlan?: RoomPlan | null
}

export function RoomsPanel({ visible, hotelName, rooms, onSelectRoom, onClose, recommendedRoomId, recommendedPlan }: RoomsPanelProps) {
  if (!visible) return null

  // Build a lookup: roomId → quantity from the recommended plan
  const planQuantities = new Map<string, number>()
  const planRoomIds = new Set<string>()
  if (recommendedPlan) {
    for (const entry of recommendedPlan.entries) {
      planQuantities.set(entry.roomId, entry.quantity)
      planRoomIds.add(entry.roomId)
    }
  }

  // A room is "recommended" if it's in the plan, or falls back to legacy recommendedRoomId
  const isRecommended = (roomId: string) => {
    if (recommendedPlan) return planRoomIds.has(roomId)
    return roomId === recommendedRoomId
  }

  // Build per-room breakdown for booking.com-style summary
  const hasAllocationPlan = recommendedPlan && recommendedPlan.entries.length > 0
  const totalRoomCount = hasAllocationPlan
    ? recommendedPlan!.entries.reduce((sum, e) => sum + e.quantity, 0)
    : 0

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="w-full max-w-3xl px-4" onClick={(event) => event.stopPropagation()}>
        <GlassPanel className="bg-white/12 px-4 py-5 backdrop-blur-2xl">
          <div className="mb-3 flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white hover:bg-white/10"
              onClick={onClose}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">Rooms</p>
              <h2 className="text-base font-semibold text-white">{hotelName || "Rooms"}</h2>
            </div>
          </div>

          {/* Booking.com-style plan summary */}
          {hasAllocationPlan && (
            <div className="mb-3 rounded-lg bg-white/8 px-3 py-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-white/50">
                Suggested plan
              </p>
              <div className="space-y-1">
                {recommendedPlan!.entries.map((entry, idx) => (
                  <div key={`${entry.roomId}-${idx}`} className="flex items-center justify-between text-[11px]">
                    <span className="text-white/90">
                      {entry.quantity > 1 ? `${entry.quantity}x ` : ""}{entry.roomName}
                      {entry.guestCount != null && (
                        <span className="ml-1 text-white/50">
                          ({entry.guestCount} guest{entry.guestCount > 1 ? "s" : ""})
                        </span>
                      )}
                    </span>
                    <span className="text-white/60">
                      ${(entry.pricePerNight * entry.quantity).toLocaleString()}/night
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-white/10 pt-1.5 text-[11px]">
                <span className="font-medium text-white/70">
                  {totalRoomCount} room{totalRoomCount > 1 ? "s" : ""} total
                </span>
                <span className="font-semibold text-white/90">
                  ${recommendedPlan!.totalPricePerNight.toLocaleString()}/night
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,180px))] justify-center gap-3">
            {rooms.length > 0 ? (
              rooms.map((room) => (
                <HotelRoomCard
                  key={room.id}
                  room={room}
                  onClick={() => onSelectRoom(room)}
                  recommended={isRecommended(room.id)}
                  recommendedQuantity={planQuantities.get(room.id)}
                />
              ))
            ) : (
              <p className="text-white/70">No rooms available for this property.</p>
            )}
          </div>
        </GlassPanel>
      </div>
    </div>
  )
}
