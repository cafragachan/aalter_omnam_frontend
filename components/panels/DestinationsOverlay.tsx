"use client"

import { ArrowLeft, MapPin, X } from "lucide-react"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { hotels } from "@/lib/hotel-data"

type DestinationsOverlayProps = {
  visible: boolean
  onSelectHotel: (slug: string) => void
  onClose: () => void
}

export function DestinationsOverlay({ visible, onSelectHotel, onClose }: DestinationsOverlayProps) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center px-4 py-10 pointer-events-none">
      <GlassPanel className="relative z-10 w-full max-w-2xl space-y-3 px-4 py-5 pointer-events-auto">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-white hover:bg-white/10"
            onClick={onClose}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">
            <MapPin className="h-3 w-3" />
            Explore Digital Twins
          </div>
          <div className="ml-auto">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white hover:bg-white/10"
              onClick={onClose}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>

        <h1 className="text-lg font-semibold text-white">Destinations</h1>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {hotels.map((hotel) => (
            <Card
              key={hotel.id}
              className={`group overflow-hidden border-white/20 bg-white/12 backdrop-blur-xl transition-all ${
                hotel.active
                  ? "cursor-pointer hover:bg-white/18 hover:shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)]"
                  : "cursor-not-allowed opacity-50 grayscale"
              }`}
              onClick={() => {
                if (hotel.active) {
                  onSelectHotel(hotel.slug)
                }
              }}
            >
              <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
                <img
                  src={hotel.image}
                  alt={hotel.name}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-black/30" />
                <div className="relative flex h-full items-center justify-center p-3 text-center">
                  <h3 className="text-sm font-bold text-white transition-transform group-hover:scale-105">
                    {hotel.name}
                  </h3>
                </div>
              </div>
              <div className="p-2">
                <p className="text-xs text-white/70">{hotel.location}</p>
                <p className="mt-0.5 text-[10px] text-white/50">{hotel.description}</p>
              </div>
            </Card>
          ))}
        </div>
      </GlassPanel>
    </div>
  )
}
