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
  const descriptionParts = [room.roomType, room.area?.label, room.view?.[0]].filter(Boolean) as string[]
  const description = descriptionParts.length > 0 ? descriptionParts.join(" | ") : "Curated room experience"

  return (
    <Card
      className={`group h-[108px] w-full cursor-pointer gap-0 overflow-hidden rounded-[10px] border bg-white/12 py-0 shadow-[0_20px_48px_-34px_rgba(0,0,0,0.9)] backdrop-blur-xl transition-all hover:bg-white/18 ${recommended ? "border-white/85 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.75),0_20px_48px_-34px_rgba(0,0,0,0.9)]" : "border-white/20"}`}
      onClick={onClick}
    >
      <div className="flex h-full w-full">
        <div className="relative h-full basis-2/5 overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
          {recommended && (
            <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
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
          <div className="absolute inset-0 bg-black/25" />
        </div>

        <div className="flex min-w-0 basis-3/5 flex-col justify-between p-2.5">
          <div className="space-y-1">
            <h3 className="truncate text-[11px] font-semibold text-white">{room.name}</h3>
            <p className="line-clamp-2 text-[10px] leading-snug text-white/65">{description}</p>
          </div>

          <div className="space-y-0.5">
            <p className="text-[10px] text-white/65">Occupancy: {room.occupancy}</p>
            <p className="text-[11px] font-semibold text-white">${room.price.toLocaleString()}/night</p>
          </div>
        </div>
      </div>
    </Card>
  )
}
