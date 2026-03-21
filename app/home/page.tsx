"use client"

import type React from "react"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Mic, MicOff, Lock, Mail, LogIn, User, Phone, Calendar } from "lucide-react"
import { DebugHud, SandboxSessionPlayer } from "@/components/liveavatar/SandboxLiveAvatar"
import { LiveAvatarContextProvider, useLiveAvatarContext } from "@/lib/liveavatar"
import { SunToggle, type SunState } from "@/components/SunToggle"
import { ProfileSync } from "@/components/ProfileSync"
import { DestinationsOverlay } from "@/components/panels/DestinationsOverlay"
import { RoomsPanel } from "@/components/panels/RoomsPanel"
// AmenitiesPanel removed — amenity navigation is now voice-driven
import { UnitDetailPanel } from "@/components/panels/UnitDetailPanel"
import { useUserProfileContext } from "@/lib/context"
import { useApp } from "@/lib/store"
import { useEmit } from "@/lib/events"
import { useJourney } from "@/lib/orchestrator"
import { useUE5Bridge } from "@/lib/ue5/bridge"
import { hotels, getHotelBySlug, getRoomsByHotelId, getAmenitiesByHotelId, getRecommendedRoomId } from "@/lib/hotel-data"
import type { Room } from "@/lib/hotel-data"
import { useUE5WebSocket } from "@/lib/useUE5WebSocket"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"

// ---------------------------------------------------------------------------
// Typewriter intro constants & component
// ---------------------------------------------------------------------------

const INTRO_MESSAGES = [
  "Welcome",
  "Your next stay begins here",
  "We'll tailor this experience to you",
  "A few details will help us personalise it",
  "Please sign in to begin",
]

const FAREWELL_MESSAGES = [
  "Thank you",
  "I'll take you to our virtual lounge now",
]

const CHAR_INTERVAL = 120
const HOLD_AFTER_TYPING = 1500
const FADE_DURATION = 1

type IntroPhase = "video" | "messages" | "login" | "farewell" | "done"

function TypewriterText({
  text,
  onComplete,
}: {
  text: string
  onComplete: () => void
}) {
  const [displayed, setDisplayed] = useState("")
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    setDisplayed("")
    let i = 0
    let timer: ReturnType<typeof setTimeout>
    function tick() {
      i++
      while (i < text.length && text[i] === " ") {
        i++
      }
      setDisplayed(text.slice(0, i))
      if (i >= text.length) {
        requestAnimationFrame(() => onCompleteRef.current())
        return
      }
      timer = setTimeout(tick, CHAR_INTERVAL)
    }
    timer = setTimeout(tick, CHAR_INTERVAL)
    return () => clearTimeout(timer)
  }, [text])

  return (
    <span
      className="text-base tracking-wide text-white md:text-xl"
      style={{ fontFamily: "var(--font-open-sans)" }}
    >
      {displayed}
    </span>
  )
}

// ---------------------------------------------------------------------------
// LoginOverlay — video + typewriter + login form, overlaid on top of UE5
// ---------------------------------------------------------------------------

function LoginOverlay({ onComplete }: { onComplete: () => void }) {
  const [phase, setPhase] = useState<IntroPhase>("video")
  const [messageIndex, setMessageIndex] = useState(0)
  const [farewellIndex, setFarewellIndex] = useState(0)
  const [messageFading, setMessageFading] = useState(false)
  const [typing, setTyping] = useState(false)
  const [showLogin, setShowLogin] = useState(false)

  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [dateOfBirth, setDateOfBirth] = useState("")
  const { login } = useApp()
  const { updateProfile, setJourneyStage } = useUserProfileContext()
  const { toast } = useToast()

  // Start messages phase after 1s of video
  useEffect(() => {
    if (phase !== "video") return
    const timer = setTimeout(() => {
      setPhase("messages")
      setTyping(true)
    }, 1000)
    return () => clearTimeout(timer)
  }, [phase])

  const handleTypewriterComplete = useCallback(() => {
    setTyping(false)
    const fadeOutTimer = setTimeout(() => {
      setMessageFading(true)
      const nextTimer = setTimeout(() => {
        setMessageFading(false)
        if (phase === "messages") {
          if (messageIndex < INTRO_MESSAGES.length - 1) {
            setMessageIndex((prev) => prev + 1)
            setTyping(true)
          } else {
            setPhase("login")
            setTimeout(() => setShowLogin(true), 200)
          }
        } else if (phase === "farewell") {
          if (farewellIndex < FAREWELL_MESSAGES.length - 1) {
            setFarewellIndex((prev) => prev + 1)
            setTyping(true)
          } else {
            setPhase("done")
            onComplete()
          }
        }
      }, FADE_DURATION)
      return () => clearTimeout(nextTimer)
    }, HOLD_AFTER_TYPING)
    return () => clearTimeout(fadeOutTimer)
  }, [messageIndex, farewellIndex, phase, onComplete])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!firstName.trim() || !lastName.trim() || !email || !password) {
      toast({
        title: "Error",
        description: "Please enter your name, surname, email, and password",
        variant: "destructive",
      })
      return
    }

    try {
      await login(email, password)
      updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email,
        familySize: 1,
        phoneNumber: phoneNumber.trim() || undefined,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
      })
      setJourneyStage("PROFILE_COLLECTION")
      // Transition to farewell messages
      setShowLogin(false)
      setTimeout(() => {
        setPhase("farewell")
        setFarewellIndex(0)
        setTyping(true)
      }, 400)
    } catch (error) {
      toast({
        title: "Error",
        description: "Login failed",
        variant: "destructive",
      })
    }
  }

  if (phase === "done") return null

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-4">
      <video
        autoPlay
        muted
        loop
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
        src="/videos/omanmBackground_720.mp4"
      />
      <div className="pointer-events-none absolute inset-0 bg-black/80" />

      {/* Sequenced typewriter messages */}
      {phase === "messages" && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center px-8 text-center"
          style={{
            opacity: messageFading ? 0 : 1,
            transition: `opacity ${FADE_DURATION}ms ease-in-out`,
          }}
        >
          {typing ? (
            <TypewriterText
              key={messageIndex}
              text={INTRO_MESSAGES[messageIndex]}
              onComplete={handleTypewriterComplete}
            />
          ) : (
            <span
              className="text-base tracking-wide text-white md:text-xl"
              style={{ fontFamily: "var(--font-open-sans)" }}
            >
              {INTRO_MESSAGES[messageIndex]}
            </span>
          )}
        </div>
      )}

      {/* Farewell typewriter messages */}
      {phase === "farewell" && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center px-8 text-center"
          style={{
            opacity: messageFading ? 0 : 1,
            transition: `opacity ${FADE_DURATION}ms ease-in-out`,
          }}
        >
          {typing ? (
            <TypewriterText
              key={`farewell-${farewellIndex}`}
              text={FAREWELL_MESSAGES[farewellIndex]}
              onComplete={handleTypewriterComplete}
            />
          ) : (
            <span
              className="text-base tracking-wide text-white md:text-xl"
              style={{ fontFamily: "var(--font-open-sans)" }}
            >
              {FAREWELL_MESSAGES[farewellIndex]}
            </span>
          )}
        </div>
      )}

      {/* Login modal */}
      <div
        className={`relative z-10 w-full max-w-md transition-all duration-600 ease-out ${
          showLogin
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        <GlassPanel className="w-full space-y-8 px-8 py-10">
          <div className="space-y-2 text-center">
            <h1 className="text-3xl tracking-tight text-white">Login</h1>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-white/90">Name</label>
              <div className="grid grid-cols-2 gap-3">
                <div className="relative">
                  <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    id="firstName"
                    type="text"
                    placeholder="First name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
                  />
                </div>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    id="lastName"
                    type="text"
                    placeholder="Surname"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium text-white/90">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium text-white/90">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label htmlFor="phone" className="text-sm font-medium text-white/90">
                  Phone
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="+1 234 567 890"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="dob" className="text-sm font-medium text-white/90">
                  Date of Birth
                </label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    id="dob"
                    type="date"
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                    className="border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"
                  />
                </div>
              </div>
            </div>
            <Button type="submit" size="lg" className="w-full">
              <LogIn className="h-4 w-4" />
              Login
            </Button>
          </form>
        </GlassPanel>
      </div>
    </div>
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
// HomePage — single page: UE5 iframe loads immediately, login overlays on top
// ---------------------------------------------------------------------------

export default function HomePage() {
  const { isAuthenticated } = useApp()
  // Track initial auth state — if already logged in on mount, skip the intro entirely
  const [wasAuthOnMount] = useState(isAuthenticated)
  const [introComplete, setIntroComplete] = useState(wasAuthOnMount)
  const [ue5Ready, setUe5Ready] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The overlay stays until introComplete — auth state changes mid-intro don't dismiss it
  const showLoginOverlay = !introComplete

  // Lightweight UE5 listener — detect the first incoming message
  const handleFirstUE5Message = useCallback(() => setUe5Ready(true), [])
  useUE5WebSocket({
    onMessage: handleFirstUE5Message,
    onUnitSelected: handleFirstUE5Message,
  })

  // Only fetch HeyGen session token once UE5 has sent its first message
  useEffect(() => {
    if (!ue5Ready) return
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
  }, [ue5Ready])

  // --- Stream config ---
  const streamMode = process.env.NEXT_PUBLIC_STREAM_MODE || "local"
  const streamUrl =
    streamMode === "vagon"
      ? process.env.NEXT_PUBLIC_VAGON_CLOUD_URL || ""
      : process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = !!streamUrl && streamUrl !== "about:blank"
  const iframeAllow =
    streamMode === "vagon"
      ? "microphone *; clipboard-read *; clipboard-write *; encrypted-media *; fullscreen *"
      : "autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"

  const handleIntroComplete = useCallback(() => setIntroComplete(true), [])

  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden">
      {/* UE5 Pixel Stream — loads immediately, behind everything */}
      {hasStream ? (
        <iframe
          id={streamMode === "vagon" ? "vagonFrame" : undefined}
          title="Vagon UE5 Stream"
          src={streamUrl}
          className="absolute inset-0 h-full w-full"
          allow={iframeAllow}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 via-black to-slate-950 text-white/70">
          Set NEXT_PUBLIC_VAGON_STREAM_URL to render the live UE5 background here.
        </div>
      )}

      {/* Login intro overlay — sits on top of iframe, hides UE5 while loading */}
      {showLoginOverlay && <LoginOverlay onComplete={handleIntroComplete} />}

      {/* Main experience (avatar, panels, etc.) — only after intro completes */}
      {introComplete && isAuthenticated && (
        <>
          {/* {!sessionToken && (
            <div className="pointer-events-none relative z-10 flex min-h-screen items-center justify-center">
              {error ? (
                <div className="text-center text-sm text-red-300">{error}</div>
              ) : (
                <div className="text-white/80 text-sm">
                  {ue5Ready ? "Launching avatar..." : "Waiting for UE5 stream..."}
                </div>
              )}
            </div>
          )} */}
          {sessionToken && (
            <LiveAvatarContextProvider sessionAccessToken={sessionToken}>
              <HomePageContent />
            </LiveAvatarContextProvider>
          )}
        </>
      )}
    </div>
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

  // --- Stream mode (for debug hud visibility) ---
  const streamMode = process.env.NEXT_PUBLIC_STREAM_MODE || "local"

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

  // --- Auto-select hotel (used by pilot mode in the journey state machine) ---
  const handleAutoSelectHotel = useCallback((slug: string) => {
    const hotel = hotels.find((h) => h.slug === slug)
    if (hotel) {
      updateProfile({ destination: hotel.location })
    }
    selectHotel(slug)
  }, [selectHotel, updateProfile])

  // --- Journey orchestrator (runs as a hook, not a component) ---
  const { dispatch: journeyDispatch } = useJourney({
    onOpenPanel: handleOpenPanel,
    onClosePanels: handleClosePanels,
    onUE5Command: ue5.sendCommand,
    onResetToDefault: handleResetToDefault,
    onFadeTransition: ue5.fadeTransition,
    onSelectHotel: handleAutoSelectHotel,
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
    <div className="relative min-h-screen w-full overflow-hidden">
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

      <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between px-6 pb-10 pt-12 sm:px-10">
        <div />

        {/* Avatar panel */}
        <div className="mt-auto grid gap-6 md:grid-cols-[210px,1fr] md:items-end">
          <div className="pointer-events-auto w-full max-w-[230px]">
            <div
              className="relative overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl"
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

      {/* Debug HUD + Profile Sync (floating, local dev only) */}
      {streamMode === "local" && (
        <div className="fixed top-4 right-4 z-30 space-y-3 pointer-events-none">
          <DebugHud />
          <ProfileSync />
        </div>
      )}

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
