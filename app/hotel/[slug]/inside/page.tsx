"use client"

import { use } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { PixelStreamFrame } from "@/components/pixel-stream-frame"
import { getHotelBySlug } from "@/lib/hotel-data"

export default function InsidePage({ params }: { params: Promise<{ slug: string }> }) {
  const resolvedParams = use(params)
  const searchParams = useSearchParams()
  const router = useRouter()
  const hotel = getHotelBySlug(resolvedParams.slug)
  const scene = searchParams.get("scene") || "room"

  if (!hotel) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-white">Hotel not found</p>
      </div>
    )
  }

  return (
    <div className="h-screen w-full">
      <PixelStreamFrame scene={scene} onBack={() => router.push(`/hotel/${resolvedParams.slug}`)} />
    </div>
  )
}
