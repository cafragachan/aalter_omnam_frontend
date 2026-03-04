"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Mic, MicOff } from "lucide-react"
import { DebugHud, SandboxSessionPlayer } from "@/components/liveavatar/SandboxLiveAvatar"
import { LiveAvatarContextProvider, useLiveAvatarContext } from "@/lib/liveavatar"
import { SunToggle, type SunState } from "@/components/SunToggle"
import { ProfileSync } from "@/components/ProfileSync"
import { DestinationsOverlay } from "@/components/panels/DestinationsOverlay"
import { RoomsPanel } from "@/components/panels/RoomsPanel"
// AmenitiesPanel removed — amenity navigation is now voice-driven
import { UnitDetailPanel } from "@/components/panels/UnitDetailPanel"
import { useUserProfileContext, type JourneyStage } from "@/lib/context"
import { useApp } from "@/lib/store"
import { useEmit } from "@/lib/events"
import { useJourney } from "@/lib/orchestrator"
import { useUE5Bridge } from "@/lib/ue5/bridge"
import { hotels, getHotelBySlug, getRoomsByHotelId, getAmenitiesByHotelId, getRecommendedRoomId } from "@/lib/hotel-data"
import type { Room } from "@/lib/hotel-data"

// ---------------------------------------------------------------------------
// Stage labels for the journey status badge
// ---------------------------------------------------------------------------

const stageLabels: Record<JourneyStage, string> = {
  PROFILE_COLLECTION: "Profile",
  DESTINATION_SELECT: "Destinations",
  HOTEL_EXPLORATION: "Hotel Exploration",
}

// ---------------------------------------------------------------------------
// HomePage — fetches session token, then renders content inside provider
// ---------------------------------------------------------------------------

export default function HomePage() {
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const startSandboxSession = async () => {
      try {
        const res = await fetch("/api/start-sandbox-session", { method: "POST" })
        if (!res.ok) {
          const resp = await res.json().catch(() => ({}))
          throw new Error(resp?.error ?? "Failed to start sandbox session")
        }
        const { session_token } = await res.json()
        setSessionToken(session_token)
      } catch (err) {
        setError((err as Error).message)
      }
    }
    startSandboxSession()
  }, [])

  // Before session token is available, show loading state
  if (!sessionToken) {
    return (
      <div className="relative flex min-h-screen w-full items-center justify-center bg-black">
        {error ? (
          <div className="text-center text-sm text-red-300">{error}</div>
        ) : (
          <div className="text-white/80">Launching sandbox avatar...</div>
        )}
      </div>
    )
  }

  // Wrap everything in LiveAvatarContextProvider so useJourney, ProfileSync,
  // DebugHud all have access to avatar context
  return (
    <LiveAvatarContextProvider sessionAccessToken={sessionToken}>
      <HomePageContent />
    </LiveAvatarContextProvider>
  )
}

// ---------------------------------------------------------------------------
// MicToggle — round mic mute/unmute button for the avatar frame
// ---------------------------------------------------------------------------

function MicToggle() {
  const { isMuted, sessionRef } = useLiveAvatarContext()

  const toggle = useCallback(() => {
    const vc = sessionRef.current?.voiceChat
    if (!vc) return
    if (isMuted) {
      vc.unmute()
    } else {
      vc.mute()
    }
  }, [isMuted, sessionRef])

  return (
    <button
      type="button"
      onClick={toggle}
      className="absolute bottom-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 backdrop-blur-md shadow-lg transition-colors hover:bg-white/20"
      title={isMuted ? "Unmute microphone" : "Mute microphone"}
    >
      {isMuted ? (
        <MicOff className="h-5 w-5 text-red-400" />
      ) : (
        <Mic className="h-5 w-5 text-white" />
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// HomePageContent — thin layout shell (all hooks available)
// ---------------------------------------------------------------------------

function HomePageContent() {
  const { selectHotel, selectedHotel } = useApp()
  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const emit = useEmit()

  // --- UI panel visibility (local state, driven by orchestrator callbacks) ---
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)

  // --- UE5 Bridge (WebSocket + fade transitions + unit state) ---
  const ue5 = useUE5Bridge()

  // --- Stream URL ---
  const streamUrl = process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = streamUrl !== "about:blank"

  // --- Hotel data ---
  const selectedHotelData = useMemo(
    () => (selectedHotel ? getHotelBySlug(selectedHotel) : undefined),
    [selectedHotel],
  )

  const rooms = useMemo(
    () => (selectedHotelData ? getRoomsByHotelId(selectedHotelData.id) : []),
    [selectedHotelData],
  )

  const amenities = useMemo(
    () => (selectedHotelData ? getAmenitiesByHotelId(selectedHotelData.id) : []),
    [selectedHotelData],
  )

  const recommendedRoomId = useMemo(
    () => getRecommendedRoomId(rooms, profile.familySize, profile.budgetRange),
    [rooms, profile.familySize, profile.budgetRange],
  )

  // --- Panel open/close callbacks (passed to useJourney) ---
  const handleOpenPanel = useCallback((panel: "rooms" | "amenities" | "location") => {
    if (panel === "rooms") {
      ue5.navigateToRooms()
      setShowRoomsPanel(true)
    } else if (panel === "location") {
      ue5.navigateToLocation()
      setShowRoomsPanel(false)
    }
    // "amenities" is now voice-driven — no panel to open
  }, [ue5])

  const handleClosePanels = useCallback(() => {
    setShowRoomsPanel(false)
  }, [])

  const handleResetToDefault = useCallback(() => {
    ue5.resetToDefault()
    ue5.clearSelectedUnit()
    setShowRoomsPanel(false)
  }, [ue5])

  // --- Journey orchestrator (runs as a hook, not a component) ---
  const { dispatch: journeyDispatch } = useJourney({
    onOpenPanel: handleOpenPanel,
    onClosePanels: handleClosePanels,
    onUE5Command: ue5.sendCommand,
    onResetToDefault: handleResetToDefault,
    onFadeTransition: ue5.fadeTransition,
    amenities,
    rooms,
  })

  // --- Reset sun position when hotel changes ---
  useEffect(() => {
    if (!selectedHotel) return
    ue5.changeSunPosition("daylight")
  }, [selectedHotel]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Hotel selection handler ---
  const handleSelectHotel = useCallback((slug: string) => {
    const hotel = hotels.find((h) => h.slug === slug)
    if (hotel) {
      updateProfile({ destination: hotel.location })
    }
    selectHotel(slug)
    setJourneyStage("HOTEL_EXPLORATION")

    journeyDispatch({
      type: "HOTEL_PICKED",
      slug,
      hotelName: hotel?.name ?? "this property",
      location: hotel?.location ?? "",
      description: hotel?.description ?? "delivers a memorable stay with thoughtful design and service",
    })
  }, [selectHotel, setJourneyStage, updateProfile, journeyDispatch])

  // --- Room selection handler (emits to EventBus) ---
  const handleSelectRoom = useCallback((room: Room) => {
    emit({
      type: "ROOM_CARD_TAPPED",
      roomId: room.id,
      roomName: room.name,
      occupancy: room.occupancy,
    })
  }, [emit])

  // --- Panel close handlers ---
  const closeRoomsPanel = useCallback(() => {
    setShowRoomsPanel(false)
    ue5.resetToDefault()
  }, [ue5])

  // --- Sun state handler ---
  const handleSunStateChange = useCallback((value: SunState) => {
    ue5.changeSunPosition(value)
  }, [ue5])

  const showDestinationsOverlay = journeyStage === "DESTINATION_SELECT"

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden">
      {/* UE5 Pixel Stream */}
      {hasStream ? (
        <iframe
          title="Vagon UE5 Stream"
          src={streamUrl}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 via-black to-slate-950 text-white/70">
          Set NEXT_PUBLIC_VAGON_STREAM_URL to render the live UE5 background here.
        </div>
      )}

      {/* Fade overlay for scene transitions */}
      {ue5.showFadeOverlay && (
        <div
          className={`pointer-events-none absolute inset-0 z-[5] bg-black transition-opacity duration-1000 ease-linear ${ue5.isFadeOpaque ? "opacity-100" : "opacity-0"}`}
        />
      )}

      {/* Sun toggle (only during hotel exploration) */}
      {selectedHotel && journeyStage === "HOTEL_EXPLORATION" && (
        <SunToggle
          value={ue5.sunState}
          onChange={handleSunStateChange}
          className="pointer-events-auto fixed left-1/2 top-1 z-20 -translate-x-1/2"
        />
      )}

      {/* Unit detail panel */}
      <UnitDetailPanel unit={ue5.selectedUnit} />

      {/* HUD: journey status + connection indicator */}
      <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between px-6 pb-10 pt-12 sm:px-10">
        <div className="flex items-start justify-between text-white/80">
          <div className="flex items-center gap-3">
            <div className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs uppercase tracking-[0.2em]">
              Journey: {stageLabels[journeyStage]}
            </div>
            <div
              className={`h-2 w-2 rounded-full ${ue5.isConnected ? "bg-green-400" : "bg-red-400"}`}
              title={ue5.isConnected ? "UE5 Connected" : "UE5 Disconnected"}
            />
          </div>
          {journeyStage === "PROFILE_COLLECTION" && (
            <div className="text-xs text-white/70">Share your travel details to see destinations</div>
          )}
        </div>

        {/* Avatar panel */}
        <div className="mt-auto grid gap-6 md:grid-cols-[420px,1fr] md:items-end">
          <div className="pointer-events-auto w-full max-w-[460px]">
            <div
              className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/70 shadow-2xl backdrop-blur"
              style={{ aspectRatio: "1 / 1.25" }}
            >
              <div className="relative w-full h-full">
                <SandboxSessionPlayer fit="cover" />
              </div>
              <MicToggle />
            </div>
          </div>
        </div>
      </div>

      {/* Debug HUD + Profile Sync (floating) */}
      <div className="fixed top-4 right-4 z-30 space-y-3 pointer-events-none">
        <DebugHud />
        <ProfileSync />
      </div>

      {/* Destinations overlay */}
      <DestinationsOverlay
        visible={showDestinationsOverlay}
        onSelectHotel={handleSelectHotel}
        onClose={() => setJourneyStage("PROFILE_COLLECTION")}
      />

      {/* Rooms panel */}
      <RoomsPanel
        visible={showRoomsPanel}
        hotelName={selectedHotelData?.name ?? ""}
        rooms={rooms}
        onSelectRoom={handleSelectRoom}
        onClose={closeRoomsPanel}
        recommendedRoomId={recommendedRoomId}
      />

      {/* Amenities are now voice-driven — no panel */}
    </div>
  )
}
