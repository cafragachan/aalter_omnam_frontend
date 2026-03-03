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
}

export function RoomsPanel({ visible, hotelName, rooms, onSelectRoom, onClose }: RoomsPanelProps) {
  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="w-full max-w-6xl px-4" onClick={(event) => event.stopPropagation()}>
        <GlassPanel className="bg-white/12 px-8 py-10 backdrop-blur-2xl">
          <div className="mb-6 flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/10"
              onClick={onClose}
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Rooms</p>
              <h2 className="text-2xl font-semibold text-white">{hotelName || "Rooms"}</h2>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,320px))] justify-center gap-6">
            {rooms.length > 0 ? (
              rooms.map((room) => (
                <HotelRoomCard
                  key={room.id}
                  room={room}
                  onClick={() => onSelectRoom(room)}
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
