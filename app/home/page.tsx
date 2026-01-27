"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft, MapPin, X } from "lucide-react"
import { SandboxLiveAvatar, DebugHud } from "@/components/liveavatar/SandboxLiveAvatar"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useUserProfile } from "@/lib/liveavatar"
import { JourneyStage, useUserProfileContext } from "@/lib/context"
import { hotels } from "@/lib/hotel-data"
import { useApp } from "@/lib/store"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useUE5WebSocket } from "@/lib/useUE5WebSocket"

const ProfileSync = () => {
  const { profile, isExtractionPending } = useUserProfile()
  const { updateProfile } = useUserProfileContext()
  const lastSyncRef = useRef<string>("")

  useEffect(() => {
    // Skip if nothing extracted yet
    const hasData =
      profile.name ||
      profile.destination ||
      profile.partySize ||
      profile.startDate ||
      profile.endDate ||
      profile.interests.length > 0 ||
      profile.travelPurpose ||
      profile.budgetRange

    if (!hasData) return

    // Create a sync key to avoid duplicate updates
    const syncKey = JSON.stringify({
      name: profile.name,
      destination: profile.destination,
      partySize: profile.partySize,
      startDate: profile.startDate?.toISOString(),
      endDate: profile.endDate?.toISOString(),
      interests: profile.interests,
      travelPurpose: profile.travelPurpose,
      budgetRange: profile.budgetRange,
    })

    if (syncKey === lastSyncRef.current) return
    lastSyncRef.current = syncKey

    const [firstName, ...lastNameParts] = (profile.name ?? "").split(" ").filter(Boolean)
    updateProfile({
      firstName: firstName || undefined,
      lastName: lastNameParts.join(" ") || undefined,
      familySize: profile.partySize,
      destination: profile.destination || undefined,
      startDate: profile.startDate || undefined,
      endDate: profile.endDate || undefined,
      interests: profile.interests,
      travelPurpose: profile.travelPurpose || undefined,
      budgetRange: profile.budgetRange || undefined,
    })
  }, [
    profile.name,
    profile.destination,
    profile.partySize,
    profile.startDate,
    profile.endDate,
    profile.interests,
    profile.travelPurpose,
    profile.budgetRange,
    updateProfile,
  ])

  // Visual indicator when AI extraction is happening
  if (isExtractionPending) {
    return (
      <div className="fixed bottom-4 left-4 z-30 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 backdrop-blur">
        Analyzing...
      </div>
    )
  }

  return null
}

const stageLabels: Record<JourneyStage, string> = {
  PROFILE_COLLECTION: "Profile",
  DESTINATION_SELECT: "Destinations",
  HOTEL_EXPLORATION: "Hotel Exploration",
  ROOM_BOOKING: "Room Booking",
}

const JourneyOrchestrator = () => {
  const { journeyStage, setJourneyStage, profile } = useUserProfileContext()
  const { repeat, interrupt } = useAvatarActions("FULL")
  // Use derived profile directly to avoid lag between AI extraction and context sync
  const { profile: derivedProfile, isExtractionPending } = useUserProfile()
  const lastPromptKey = useRef<string>("")

  // Ready to show destinations when we have: dates, guests, and interests
  // Note: destination is NOT required here - the overlay helps them pick one
  const readyForDestinations =
    Boolean(derivedProfile.partySize) &&
    Boolean(derivedProfile.startDate && derivedProfile.endDate) &&
    derivedProfile.interests.length > 0

  // Drive prompts for missing data during profile collection
  useEffect(() => {
    if (journeyStage !== "PROFILE_COLLECTION") return
    // Wait for AI extraction to complete before prompting - prevents choppy interruptions
    // when user answers multiple questions at once
    if (isExtractionPending) return

    const missingDates = !derivedProfile.startDate || !derivedProfile.endDate
    const missingGuests = !derivedProfile.partySize
    const missingInterests = derivedProfile.interests.length === 0

    const key = `profile-${missingDates}-${missingGuests}-${missingInterests}`
    if (lastPromptKey.current === key) return
    lastPromptKey.current = key

    const firstName =
      profile.firstName?.trim() ||
      (derivedProfile.name ? derivedProfile.name.split(" ")[0] : "") ||
      "there"

    // First, ask for travel dates and party size
    if (missingDates && missingGuests) {
      interrupt()
      repeat(
        `${firstName}, to find the perfect property for you, I need to know: when are you planning to travel and how many guests will be joining you?`,
      ).catch(() => undefined)
      return
    }
    else if (missingDates) {
      interrupt()
      repeat(
        `${firstName}, could you please confirm: when are you planning to travel?`,
      ).catch(() => undefined)
      return
    }
    else if (missingGuests) {
      interrupt()
      repeat(
        `${firstName}, I'd also need to know: how many guests will be joining you?`,
      ).catch(() => undefined)
      return
    }

    // Then ask for interests to help recommend destinations
    if (missingInterests) {
      interrupt()
      repeat(
        `Perfect! Now tell me, what kind of experiences are you looking for and places to visit? Are you interested in relaxation, adventure, culture, gastronomy, or something else?`,
      ).catch(() => undefined)
      return
    }
  }, [
    interrupt,
    isExtractionPending,
    journeyStage,
    derivedProfile.endDate,
    derivedProfile.partySize,
    profile.firstName,
    derivedProfile.interests.length,
    derivedProfile.startDate,
    derivedProfile.name,
    repeat,
  ])

  // Advance to destination selection when we have enough context
  useEffect(() => {
    // Wait for extraction to complete before advancing stage
    if (isExtractionPending) return
    if (journeyStage === "PROFILE_COLLECTION" && readyForDestinations) {
      setJourneyStage("DESTINATION_SELECT")
      // interrupt()?.catch(() => undefined)
      repeat(
        "Wonderful! Based on your preferences, let me show you some destinations I think you'll love.",
      ).catch(() => undefined)
    }
  }, [readyForDestinations, journeyStage, isExtractionPending, interrupt, repeat, setJourneyStage])

  // Prompt when destinations overlay is shown
  useEffect(() => {
    if (journeyStage !== "DESTINATION_SELECT") return
    if (lastPromptKey.current === "destinations-shown") return
    lastPromptKey.current = "destinations-shown"
    // Small delay to let the overlay render
    const timer = setTimeout(() => {
      repeat("Take a look at these properties. Tap any card to explore the digital twin.").catch(
        () => undefined,
      )
    }, 500)
    return () => clearTimeout(timer)
  }, [journeyStage, repeat])

  return null
}

export default function HomePage() {
  const router = useRouter()
  const { selectHotel } = useApp()
  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamUrl = process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = streamUrl !== "about:blank"

  // UE5 WebSocket message handler - memoized to prevent reconnection loops
  const handleUE5Message = useCallback((msg: import("@/lib/useUE5WebSocket").UE5IncomingMessage) => {
    console.log("UE5 message received:", msg)
  }, [])

  // UE5 WebSocket connection (single instance via hook to avoid multiple sockets)
  const { isConnected, sendStartTest, sendRawMessage } = useUE5WebSocket({
    onMessage: handleUE5Message,
  })

  const handleSendMessage = useCallback((type: string, value: unknown) => {
    sendRawMessage({ type, value })
  }, [sendRawMessage])

  // Ready for destination selection when we have basic info + travel context
  // Note: destination is selected via the overlay, not collected beforehand
  const readyForDestinationSelect = useMemo(
    () =>
      Boolean(
        profile.firstName &&
        profile.email &&
        profile.familySize &&
        profile.startDate &&
        profile.endDate &&
        profile.interests.length > 0,
      ),
    [
      profile.email,
      profile.familySize,
      profile.firstName,
      profile.interests.length,
      profile.startDate,
      profile.endDate,
    ],
  )

  useEffect(() => {
    if (journeyStage === "PROFILE_COLLECTION" && readyForDestinationSelect) {
      setJourneyStage("DESTINATION_SELECT")
    }
  }, [journeyStage, readyForDestinationSelect, setJourneyStage])

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

  const handleSelectHotel = (slug: string) => {
    const hotel = hotels.find((h) => h.slug === slug)

    // Update profile with selected destination
    if (hotel) {
      updateProfile({ destination: hotel.location })
    }

    selectHotel(slug)

    setJourneyStage("HOTEL_EXPLORATION")

    //sendStartTest(slug)

    handleSendMessage("startTEST", "startTEST")

    // if (slug === "edition-lake-como") {
    //   router.push("/metaverse")
    //   return
    // }
    // router.push(`/hotel/${slug}`)
  }

  const showDestinationsOverlay = journeyStage === "DESTINATION_SELECT"

  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden">
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

      <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between px-6 pb-10 pt-12 sm:px-10">
        <div className="flex items-start justify-between text-white/80">
          <div className="flex items-center gap-3">
            <div className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs uppercase tracking-[0.2em]">
              Journey: {stageLabels[journeyStage]}
            </div>
            <div
              className={`h-2 w-2 rounded-full ${isConnected ? "bg-green-400" : "bg-red-400"}`}
              title={isConnected ? "UE5 Connected" : "UE5 Disconnected"}
            />
          </div>
          {journeyStage === "PROFILE_COLLECTION" && (
            <div className="text-xs text-white/70">Share your travel details to see destinations</div>
          )}
        </div>

        <div className="mt-auto grid gap-6 md:grid-cols-[420px,1fr] md:items-end">
          <div className="pointer-events-auto w-full max-w-[460px]">
            <div
              className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/70 shadow-2xl backdrop-blur"
              style={{ aspectRatio: "1 / 1.25" }}
            >
              {error && (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-300">
                  {error}
                </div>
              )}

              {!error && !sessionToken && (
                <div className="flex h-full items-center justify-center text-white/80">Launching sandbox avatar...</div>
              )}

              {sessionToken && (
                <SandboxLiveAvatar
                  sessionToken={sessionToken}
                  fit="cover"
                  renderHud={
                    <div className="fixed top-4 right-4 z-30 space-y-3 pointer-events-none">
                      <DebugHud />
                      <ProfileSync />
                      <JourneyOrchestrator />
                    </div>
                  }
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {showDestinationsOverlay && (
        <div className="fixed inset-0 z-20 flex items-center justify-center px-4 py-10 pointer-events-none">
          <GlassPanel className="relative z-10 w-full max-w-5xl space-y-6 px-8 py-10 pointer-events-auto">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/10"
                onClick={() => setJourneyStage("PROFILE_COLLECTION")}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
                <MapPin className="h-4 w-4" />
                Explore Digital Twins
              </div>
              <div className="ml-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white hover:bg-white/10"
                  onClick={() => setJourneyStage("PROFILE_COLLECTION")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <h1 className="text-3xl font-semibold text-white">Destinations</h1>

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {hotels.map((hotel) => (
                <Card
                  key={hotel.id}
                  className={`group overflow-hidden border-white/20 bg-white/12 backdrop-blur-xl transition-all ${hotel.active
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
      )}
    </div>
  )
}
