import { Card } from "@/components/ui/card"
import type { Room } from "@/lib/hotel-data"

interface HotelRoomCardProps {
  room: Room
  onClick?: () => void
  recommended?: boolean
  /** How many of this room type are in the recommended plan (e.g. 2 = "x2") */
  recommendedQuantity?: number
}

export function HotelRoomCard({ room, onClick, recommended, recommendedQuantity }: HotelRoomCardProps) {
  return (
    <Card
      className={`group h-full w-full cursor-pointer overflow-hidden border-white/20 bg-white/12 backdrop-blur-xl transition-all hover:bg-white/18 hover:shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)] ${recommended ? "ring-2 ring-white/70" : ""}`}
      onClick={onClick}
    >
      <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
        {recommended && (
          <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
            <span className="rounded-full bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-black shadow-lg">
              Selected
            </span>
            {recommendedQuantity != null && recommendedQuantity > 1 && (
              <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[9px] font-bold text-black shadow-lg">
                x{recommendedQuantity}
              </span>
            )}
          </div>
        )}
        <img
          src={room.image}
          alt={room.name}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-black/30" />
        <div className="relative flex h-full items-center justify-center p-3 text-center">
          <h3 className="text-xs font-bold text-white">{room.name}</h3>
        </div>
      </div>
      <div className="flex items-center justify-between p-2">
        <div>
          <p className="text-[10px] font-semibold text-white">{room.name}</p>
          <p className="mt-0.5 text-[9px] text-white/60">Occupancy: {room.occupancy}</p>
        </div>
        <p className="text-sm font-bold text-white">${room.price}</p>
      </div>
    </Card>
  )
}
