"use client"

import { ArrowLeft } from "lucide-react"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { HotelAmenityCard } from "@/components/HotelAmenityCard"
import type { Amenity } from "@/lib/hotel-data"

type AmenitiesPanelProps = {
  visible: boolean
  hotelName: string
  amenities: Amenity[]
  onSelectAmenity: (amenity: Amenity) => void
  onClose: () => void
}

export function AmenitiesPanel({ visible, hotelName, amenities, onSelectAmenity, onClose }: AmenitiesPanelProps) {
  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="w-full max-w-5xl px-4" onClick={(event) => event.stopPropagation()}>
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
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Amenities</p>
              <h2 className="text-2xl font-semibold text-white">{hotelName || "Amenities"}</h2>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,320px))] justify-center gap-6">
            {amenities.length > 0 ? (
              amenities.map((amenity) => (
                <HotelAmenityCard
                  key={amenity.id}
                  amenity={amenity}
                  onClick={() => onSelectAmenity(amenity)}
                />
              ))
            ) : (
              <p className="text-white/70">No amenities available for this property.</p>
            )}
          </div>
        </GlassPanel>
      </div>
    </div>
  )
}
