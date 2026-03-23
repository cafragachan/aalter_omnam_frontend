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
  /** Multi-room recommendation plan */
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

  // Build plan summary text
  const planSummary = recommendedPlan && recommendedPlan.entries.length > 0
    ? recommendedPlan.entries
        .map((e) => `${e.quantity > 1 ? `${e.quantity}x ` : ""}${e.roomName}`)
        .join(" + ")
    : null

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

          {/* Plan summary bar */}
          {planSummary && (
            <div className="mb-3 rounded-lg bg-white/8 px-3 py-2 text-[11px] text-white/80">
              <span className="font-semibold text-white/90">Suggested: </span>
              {planSummary}
              <span className="ml-1.5 text-white/60">
                — ${recommendedPlan!.totalPricePerNight.toLocaleString()}/night total
              </span>
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
