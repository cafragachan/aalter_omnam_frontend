"use client"

import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { hotels } from "@/lib/hotel-data"
import { useApp } from "@/lib/store"
import { ArrowLeft} from "lucide-react"
import { GlassPanel } from "@/components/glass-panel"

export default function DestinationsPage() {
  const router = useRouter()
  const { selectHotel } = useApp()

  const handleSelectHotel = (slug: string) => {
    selectHotel(slug)
    if (slug === "edition-lake-como") {
      router.push("/metaverse")
      return
    }
    router.push(`/hotel/${slug}`)
  }

  return (
    <div
      className="ios-screen flex min-h-screen items-center justify-center bg-cover bg-center p-4"
      style={{ backgroundImage: 'url("/images/login-bg.jpg")' }}
    >
      <GlassPanel className="relative z-10 w-full max-w-4hotel cards in \destination page. xl space-y-6 px-8 py-10">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => router.back()}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
                {/* <MapPin className="h-4 w-4" /> */}
                Explore Digital Twins
              </div>
              <h1 className="text-3xl font-semibold text-white">Destinations</h1>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
                    handleSelectHotel(hotel.slug)
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
                  <div className="relative flex h-full items-center justify-center p-6 text-center">
                    <h3 className="text-xl font-bold text-white transition-transform group-hover:scale-105">
                      {hotel.name}
                    </h3>
                  </div>
                </div>
                <div className="p-4">
                  <p className="text-sm text-white/70">{hotel.location}</p>
                  <p className="mt-1 text-xs text-white/50">{hotel.description}</p>
                </div>
              </Card>
            ))}
          </div>
        
      </GlassPanel>
    </div>
  )
}
