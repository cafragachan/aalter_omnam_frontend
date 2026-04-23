"use client"

import { useMemo, useState } from "react"
import { RoomsPanel } from "@/components/panels/RoomsPanel"
import { Button } from "@/components/ui/button"
import { getRoomsByHotelId, type RoomPlan } from "@/lib/hotel-data"

const AVATAR_WIDTH = 210
const ROOMS_PANEL_WIDTH = Math.round(AVATAR_WIDTH * 1.3)

export default function RoomsTestPage() {
  const rooms = useMemo(() => getRoomsByHotelId("1"), [])
  const [showPanel, setShowPanel] = useState(true)

  const recommendedPlan = useMemo<RoomPlan | null>(() => {
    const first = rooms[0]
    const second = rooms[1]
    if (!first) return null

    const entries: RoomPlan["entries"] = [
      {
        roomId: first.id,
        roomName: first.name,
        quantity: 1,
        pricePerNight: first.price,
        occupancy: parseInt(first.occupancy, 10) || 2,
      },
    ]

    if (second) {
      entries.push({
        roomId: second.id,
        roomName: second.name,
        quantity: 1,
        pricePerNight: second.price,
        occupancy: parseInt(second.occupancy, 10) || 2,
      })
    }

    return {
      entries,
      totalCapacity: entries.reduce((sum, entry) => sum + entry.occupancy * entry.quantity, 0),
      totalPricePerNight: entries.reduce((sum, entry) => sum + entry.pricePerNight * entry.quantity, 0),
    }
  }, [rooms])

  return (
    <main className="relative min-h-screen w-full overflow-hidden">
      <video
        autoPlay
        muted
        loop
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
        src="/videos/omanmBackground_720.mp4"
      />
      <div className="absolute inset-0 bg-black/55" />

      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="pointer-events-auto absolute left-6 top-6 flex items-center gap-3 rounded-xl border border-white/20 bg-black/45 px-3 py-2 text-xs text-white/85 backdrop-blur-md">
          <span>Route: /rooms-test</span>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs text-white hover:bg-white/10"
            onClick={() => setShowPanel((prev) => !prev)}
          >
            {showPanel ? "Hide panel" : "Show panel"}
          </Button>
        </div>

        {showPanel && (
          <div className="fixed right-4 top-4 bottom-[calc(4rem+2vh)] z-20">
            <div className="h-full" style={{ width: ROOMS_PANEL_WIDTH }}>
              <RoomsPanel
                visible={showPanel}
                hotelName="EDITION | Lake Como"
                rooms={rooms}
                onClose={() => setShowPanel(false)}
                recommendedPlan={recommendedPlan}
              />
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
