import { Card } from "@/components/ui/card"
import type { Room } from "@/lib/hotel-data"

interface HotelRoomCardProps {
  room: Room
  onClick?: () => void
  recommended?: boolean
}

export function HotelRoomCard({ room, onClick, recommended }: HotelRoomCardProps) {
  return (
    <Card
      className={`group h-full w-full cursor-pointer overflow-hidden border-white/20 bg-white/12 backdrop-blur-xl transition-all hover:bg-white/18 hover:shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)] ${recommended ? "ring-2 ring-white/70" : ""}`}
      onClick={onClick}
    >
      <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
        {recommended && (
          <div className="absolute top-3 right-3 z-10 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-black shadow-lg">
            Recommended
          </div>
        )}
        <img
          src={room.image}
          alt={room.name}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-black/30" />
        <div className="relative flex h-full items-center justify-center p-6 text-center">
          <h3 className="text-xl font-bold text-white">{room.name}</h3>
        </div>
      </div>
      <div className="flex items-center justify-between p-4">
        <div>
          <p className="text-sm font-semibold text-white">{room.name}</p>
          <p className="mt-1 text-xs text-white/60">Occupancy: {room.occupancy}</p>
        </div>
        <p className="text-lg font-bold text-white">${room.price}</p>
      </div>
    </Card>
  )
}
