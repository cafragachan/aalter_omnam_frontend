"use client"

import { use } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { getHotelBySlug } from "@/lib/hotel-data"
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react"
import { GlassPanel } from "@/components/glass-panel"

export default function OutsidePage({ params }: { params: Promise<{ slug: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const hotel = getHotelBySlug(resolvedParams.slug)

  if (!hotel) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-white">Hotel not found</p>
      </div>
    )
  }

  return (
    <div
      className="ios-screen flex min-h-screen flex-col items-center justify-center bg-cover bg-center p-4"
      style={{ backgroundImage: 'url("/placeholders/hotel-bg.svg")' }}
    >
      <div className="absolute left-4 top-4 z-10">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
      </div>

      <GlassPanel className="relative z-10 w-full max-w-2xl space-y-6 text-center px-8 py-10">
        <div className="flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
          <Sparkles className="h-4 w-4" />
          Exterior View
        </div>
        <h1 className="text-3xl font-semibold text-white">{hotel.name}</h1>
        <p className="text-lg text-white/80">Exterior View</p>
        <Button
          size="lg"
          className="w-full text-lg"
          onClick={() => router.push(`/hotel/${resolvedParams.slug}/inside?scene=room`)}
        >
          View Inside
          <ArrowRight className="h-4 w-4" />
        </Button>
      </GlassPanel>
    </div>
  )
}
