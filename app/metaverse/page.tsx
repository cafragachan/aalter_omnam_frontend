"use client"

import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { GlassPanel } from "@/components/glass-panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useApp } from "@/lib/store"
import { getAmenitiesByHotelId, getHotelBySlug, getRoomsByHotelId } from "@/lib/hotel-data"
import { HotelRoomCard } from "@/components/HotelRoomCard"
import { HotelAmenityCard } from "@/components/HotelAmenityCard"
import { useEffect, useRef, useState } from "react"

export default function MetaversePage() {
  const router = useRouter()
  const { selectedHotel } = useApp()
  // For local development, point this to your local Pixel Stream
  const streamUrl = process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = streamUrl !== "about:blank"
  const websocket = useRef<WebSocket | null>(null)
  const [activeTab, setActiveTab] = useState<string>("")
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)
  const [showAmenitiesPanel, setShowAmenitiesPanel] = useState(false)

  const hotel = selectedHotel ? getHotelBySlug(selectedHotel) : getHotelBySlug("edition-lake-como")
  const rooms = hotel ? getRoomsByHotelId(hotel.id) : []
  const amenities = hotel ? getAmenitiesByHotelId(hotel.id) : []

  useEffect(() => {
    // Connect to the UE5 WebSocket server
    const ws = new WebSocket("ws://localhost:7788")
    websocket.current = ws // Set the ref immediately

    ws.onopen = () => {
      console.log("Connected to UE5 WebSocket server")
      websocket.current = ws
    }

    ws.onmessage = async (event) => {
      let messageData = event.data

      // Check if the received data is a Blob
      if (event.data instanceof Blob) {
        console.log("Received a Blob from UE5, converting to text...")
        // Asynchronously read the Blob's content as a string
        messageData = await event.data.text()
      }

      console.log("Message from UE5:", messageData)

      try {
        JSON.parse(messageData)
      } catch (e) {
        // It wasn't JSON, just a plain string.
      }
    }

    ws.onclose = () => {
      console.log("Disconnected from UE5 WebSocket server")
    }

    ws.onerror = (error) => {
      console.error("WebSocket error:", error)
    }

    return () => {
      console.log("Component unmounting, closing WebSocket.")
      if (websocket.current) {
        websocket.current.close()
      }
    }
  }, [])

  const sendMessageToUE5 = (message: object) => {
    if (websocket.current && websocket.current.readyState === WebSocket.OPEN) {
      websocket.current.send(JSON.stringify(message))
    } else {
      console.error("WebSocket is not connected.")
    }
  }

  const handleSendMessage = (type: string, value: unknown) => {
    sendMessageToUE5({ type, value })
  }

  const resetTabSelection = (sendDefaultMessage: boolean) => {
    setActiveTab("")
    if (sendDefaultMessage) {
      handleSendMessage("gameEstate", "default")
    }
  }

  const handleResetTabs = () => {
    setShowRoomsPanel(false)
    setShowAmenitiesPanel(false)
    resetTabSelection(true)
  }

  const handleTabChange = (value: string) => {
    setActiveTab(value)

    if (value === "location") {
      handleSendMessage("gameEstate", "location")
      closeRoomsPanel()
      closeAmenitiesPanel()
    }

    if (value === "rooms") {
      handleRoomsTab()
    }

    if (value === "amenities") {
      handleAmenitiesTab()
    }
  }

  const handleRoomsTab = () => {
    handleSendMessage("gameEstate", "rooms")
    setShowRoomsPanel(true)
    setShowAmenitiesPanel(false)
  }

  const closeRoomsPanel = () => {
    setShowRoomsPanel(false)
    resetTabSelection(true)
  }
  const handleAmenitiesTab = () => {
    handleSendMessage("gameEstate", "amenities")
    setShowAmenitiesPanel(true)
    setShowRoomsPanel(false)
  }
  const closeAmenitiesPanel = () => {
    setShowAmenitiesPanel(false)
    resetTabSelection(true)
  }

  return (
    <div className="relative min-h-screen w-full bg-black pb-32">
      {hasStream && (
        <iframe
          title="Vagon UE5 Stream"
          src={streamUrl}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"
        />
      )}

      <div className="relative z-10 flex items-center gap-3 p-4">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="text-xs font-semibold uppercase tracking-[0.3em] text-white/70">PIE Stream</div>
      </div>

      {!hasStream && (
        <div className="relative z-10 flex min-h-screen items-center justify-center px-6">
          <div className="max-w-lg rounded-2xl border border-white/20 bg-white/10 px-6 py-8 text-center text-white backdrop-blur-xl">
            <h1 className="text-2xl font-semibold">Stream Placeholder</h1>
            <p className="mt-3 text-sm text-white/70">
              Set <span className="font-semibold">NEXT_PUBLIC_VAGON_STREAM_URL</span> to your local PIE stream or Vagon
              session URL to render the iframe here.
            </p>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-8">
        <div className="pointer-events-auto w-full max-w-5xl">
          <div className="relative flex items-center justify-center">
            {activeTab && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute -left-16 top-1/2 h-12 w-12 -translate-y-1/2 rounded-full border border-white/25 bg-white/15 text-white shadow-lg shadow-black/30 backdrop-blur-xl transition hover:bg-white/25"
                onClick={handleResetTabs}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
            )}

            <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger
                  value="location"
                  className="border border-transparent transition hover:border-white"
                >
                  Location
                </TabsTrigger>
                <TabsTrigger
                  value="rooms"
                  className="border border-transparent transition hover:border-white"
                >
                  Rooms
                </TabsTrigger>
                <TabsTrigger
                  value="amenities"
                  className="border border-transparent transition hover:border-white"
                >
                  Amenities
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </div>

      {showRoomsPanel && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={closeRoomsPanel}
        >
          <div className="w-full max-w-6xl px-4" onClick={(event) => event.stopPropagation()}>
            <GlassPanel className="bg-white/12 px-8 py-10 backdrop-blur-2xl">
              <div className="mb-6 flex items-center gap-3">
                <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={closeRoomsPanel}>
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Rooms</p>
                  <h2 className="text-2xl font-semibold text-white">{hotel?.name || "Rooms"}</h2>
                </div>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,320px))] justify-center gap-6">
                {rooms.length > 0 ? (
                  rooms.map((room) => (
                    <HotelRoomCard
                      key={room.id}
                      room={room}
                      onClick={() => {
                        handleSendMessage("selectedRoom", room.id)
                        closeRoomsPanel()
                      }}
                    />
                  ))
                ) : (
                  <p className="text-white/70">No rooms available for this property.</p>
                )}
              </div>
            </GlassPanel>
          </div>
        </div>
      )}

      {showAmenitiesPanel && (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={closeAmenitiesPanel}
        >
          <div className="w-full max-w-5xl px-4" onClick={(event) => event.stopPropagation()}>
            <GlassPanel className="bg-white/12 px-8 py-10 backdrop-blur-2xl">
              <div className="mb-6 flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white hover:bg-white/10"
                  onClick={closeAmenitiesPanel}
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Amenities</p>
                  <h2 className="text-2xl font-semibold text-white">{hotel?.name || "Amenities"}</h2>
                </div>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,320px))] justify-center gap-6">
                {amenities.length > 0 ? (
                  amenities.map((amenity) => (
                    <HotelAmenityCard
                      key={amenity.id}
                      amenity={amenity}
                      onClick={() => {
                        handleSendMessage("selectedAmenity", amenity.id)
                        closeAmenitiesPanel()
                      }}
                    />
                  ))
                ) : (
                  <p className="text-white/70">No amenities available for this property.</p>
                )}
              </div>
            </GlassPanel>
          </div>
        </div>
      )}
    </div>
  )
}
