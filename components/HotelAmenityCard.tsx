import { Card } from "@/components/ui/card"
import type { Amenity } from "@/lib/hotel-data"

interface HotelAmenityCardProps {
  amenity: Amenity
  onClick?: () => void
}

export function HotelAmenityCard({ amenity, onClick }: HotelAmenityCardProps) {
  return (
    <Card
      className="group h-full w-full cursor-pointer overflow-hidden border-white/20 bg-white/12 backdrop-blur-xl transition-all hover:bg-white/18 hover:shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)]"
      onClick={onClick}
    >
      <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
        <img
          src={amenity.image}
          alt={amenity.name}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-black/30" />
        <div className="relative flex h-full items-center justify-center p-6 text-center">
          <h3 className="text-xl font-bold text-white">{amenity.name}</h3>
        </div>
      </div>
      <div className="p-4">
        <p className="text-sm font-semibold text-white">{amenity.name}</p>
        <p className="mt-1 text-xs text-white/60">Tap to preview this amenity in the experience.</p>
      </div>
    </Card>
  )
}
