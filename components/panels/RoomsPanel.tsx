"use client"

import { ArrowLeft } from "lucide-react"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { HotelRoomCard } from "@/components/HotelRoomCard"
import type { Room } from "@/lib/hotel-data"

type RoomsPanelProps = {
  visible: boolean
  hotelName: string
  rooms: Room[]
  onSelectRoom: (room: Room) => void
  onClose: () => void
  recommendedRoomId?: string | null
}

export function RoomsPanel({ visible, hotelName, rooms, onSelectRoom, onClose, recommendedRoomId }: RoomsPanelProps) {
  if (!visible) return null

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
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,180px))] justify-center gap-3">
            {rooms.length > 0 ? (
              rooms.map((room) => (
                <HotelRoomCard
                  key={room.id}
                  room={room}
                  onClick={() => onSelectRoom(room)}
                  recommended={room.id === recommendedRoomId}
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
