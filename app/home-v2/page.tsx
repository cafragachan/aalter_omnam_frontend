"use client"

// Stage 5 of the HeyGen → LiveKit migration: parallel home page.
//
// Copied from app/home/page.tsx with import-only changes plus the
// Stage 5 bridge wiring (useStateSyncBridge + useToolCallBridge +
// avatarHooks passed into useJourney). EVERY piece of journey logic,
// UI, auth, Vagon lifecycle, intro animation, and panel code is kept
// byte-for-byte identical to /home — the only difference is where the
// avatar session comes from and how SPEAK effects are routed.
//
// See C:\Users\CesarFragachan\.claude\plans\declarative-crafting-pixel.md
// Stage 5 for the full delta.

import type React from "react"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Mic, MicOff, Lock, Mail, LogIn, User, Phone, Calendar, UserPlus, ArrowLeft, Globe } from "lucide-react"
import { DebugHud, LiveKitAvatarPlayer, useDebugLogger } from "@/components/livekit/LiveKitAvatarPlayer"
import {
  LiveKitAvatarContextProvider,
  useLiveKitAvatarContext,
  SessionState,
  useAvatarActions,
  useUserProfile,
} from "@/lib/livekit"
import { useStateSyncBridge } from "@/lib/livekit/useStateSyncBridge"
import { useToolCallBridge } from "@/lib/livekit/useToolCallBridge"
import { SunToggle, type SunState } from "@/components/SunToggle"
import { ProfileSync } from "@/components/ProfileSync"
import { DestinationsOverlay } from "@/components/panels/DestinationsOverlay"
import { RoomsPanel } from "@/components/panels/RoomsPanel"
// AmenitiesPanel removed — amenity navigation is now voice-driven
import { UnitDetailPanel } from "@/components/panels/UnitDetailPanel"
import { useUserProfileContext } from "@/lib/context"
import { useApp } from "@/lib/store"
import { useAuth } from "@/lib/auth-context"
import { useEmit } from "@/lib/events"
import { useJourney, type UseJourneyAvatarHooks } from "@/lib/orchestrator/useJourney"
import { useUE5Bridge } from "@/lib/ue5/bridge"
import { useVagonSession } from "@/lib/ue5/useVagonSession"
import { hotels, getHotelBySlug, getRoomsByHotelId, getAmenitiesByHotelId, getRecommendedRoomId, getRecommendedRoomPlan } from "@/lib/hotel-data"
import type { Room } from "@/lib/hotel-data"
import { useUE5WebSocket } from "@/lib/useUE5WebSocket"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useIncrementalPersistence } from "@/lib/firebase/useIncrementalPersistence"

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
// EndExperienceOverlay — farewell message over intro video background
// ---------------------------------------------------------------------------

function EndExperienceOverlay({ firstName }: { firstName?: string }) {
  const name = firstName ?? "guest"
  const message = `Thank you ${name}, we hope to see you again soon`

  const [phase, setPhase] = useState<"fade-in" | "typing" | "hold">("fade-in")

  useEffect(() => {
    const timer = setTimeout(() => setPhase("typing"), 500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-1000 ${phase === "fade-in" ? "opacity-0" : "opacity-100"}`}
    >
      <video
        autoPlay
        muted
        loop
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
        src="/videos/omanmBackground_720.mp4"
      />
      <div className="absolute inset-0 bg-black/80" />

      <div className="relative z-10 text-center px-8">
        {phase === "typing" && (
          <TypewriterText
            text={message}
            onComplete={() => setPhase("hold")}
          />
        )}
        {phase === "hold" && (
          <span
            className="text-base tracking-wide text-white md:text-xl"
            style={{ fontFamily: "var(--font-open-sans)" }}
          >
            {message}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LoginOverlay — video + typewriter + login form, overlaid on top of UE5
// ---------------------------------------------------------------------------

type AuthMode = "login" | "register"

function LoginOverlay({ onComplete, skipIntro = false }: { onComplete: () => void; skipIntro?: boolean }) {
  const [phase, setPhase] = useState<IntroPhase>("video")
  const [messageIndex, setMessageIndex] = useState(0)
  const [farewellIndex, setFarewellIndex] = useState(0)
  const [messageFading, setMessageFading] = useState(false)
  const [typing, setTyping] = useState(false)
  const [showForm, setShowForm] = useState(false)

  // Auth mode: login (email+password only) vs register (all fields)
  const [authMode, setAuthMode] = useState<AuthMode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [dateOfBirth, setDateOfBirth] = useState("")
  const [nationality, setNationality] = useState("")
  const [authError, setAuthError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { login, register, isAuthReady } = useAuth()
  const { updateProfile, setJourneyStage } = useUserProfileContext()

  // Local mode: skip intro animations, always show login form
  const didSkipRef = useRef(false)
  useEffect(() => {
    if (!skipIntro || didSkipRef.current) return
    if (isAuthReady) {
      didSkipRef.current = true
      setPhase("login")
      setShowForm(true)
    }
  }, [skipIntro, isAuthReady])

  // Start messages phase after 1s of video
  useEffect(() => {
    if (phase !== "video" || skipIntro) return
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
            setTimeout(() => setShowForm(true), 200)
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

  /** After successful auth, sync profile and transition to farewell */
  const completeAuth = useCallback(
    (profile: { firstName: string; lastName: string; email: string; phoneNumber: string; dateOfBirth: string; nationality: string; languagePreference: string }) => {
      updateProfile({
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        familySize: 1,
        phoneNumber: profile.phoneNumber || undefined,
        dateOfBirth: profile.dateOfBirth ? new Date(profile.dateOfBirth) : undefined,
        nationality: profile.nationality || undefined,
        languagePreference: profile.languagePreference || undefined,
      })
      setJourneyStage("PROFILE_COLLECTION")
      setShowForm(false)
      setTimeout(() => {
        setPhase("farewell")
        setFarewellIndex(0)
        setTyping(true)
      }, 400)
    },
    [updateProfile, setJourneyStage],
  )

  const switchMode = useCallback((mode: AuthMode) => {
    setAuthMode(mode)
    setAuthError(null)
  }, [])

  /** Handle login form submission */
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) {
      setAuthError("Please enter your email and password.")
      return
    }
    setAuthError(null)
    setIsSubmitting(true)
    try {
      const profile = await login(email, password)
      completeAuth(profile)
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code === "auth/user-not-found" || code === "auth/invalid-credential") {
        setAuthError("No account found with this email. Please register.")
      } else if (code === "auth/wrong-password") {
        setAuthError("Incorrect password. Please try again.")
      } else if (code === "auth/too-many-requests") {
        setAuthError("Too many failed attempts. Please try again later.")
      } else {
        setAuthError("Login failed. Please try again.")
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  /** Handle register form submission */
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!firstName.trim() || !lastName.trim() || !email || !password) {
      setAuthError("Please fill in all required fields.")
      return
    }
    if (password.length < 8 || !/[^A-Za-z0-9]/.test(password)) {
      setAuthError("Password must be at least 8 characters with a special character.")
      return
    }
    if (password !== confirmPassword) {
      setAuthError("Passwords do not match.")
      return
    }
    setAuthError(null)
    setIsSubmitting(true)
    try {
      const profile = await register({
        email,
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phoneNumber: phoneNumber.trim(),
        dateOfBirth,
        nationality: nationality.trim(),
        languagePreference: "",
      })
      completeAuth(profile)
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code === "auth/email-already-in-use") {
        setAuthError("This email is already registered. Please sign in.")
      } else if (code === "auth/weak-password") {
        setAuthError("Password is too weak. Use at least 8 characters with a special character.")
      } else {
        setAuthError("Registration failed. Please try again.")
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (phase === "done") return null

  const inputClass = "border-white/60 bg-white/25 pl-10 text-slate-900 placeholder:text-slate-600"

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

      {/* Auth form (login or register) */}
      <div
        className={`relative z-10 w-full max-w-md transition-all duration-600 ease-out ${
          showForm
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        <GlassPanel className="w-full space-y-6 px-8 py-10">
          {/* --- LOGIN MODE --- */}
          {authMode === "login" && (
            <>
              <div className="space-y-2 text-center">
                <h1 className="text-3xl tracking-tight text-white">Welcome Back</h1>
                <p className="text-sm text-white/60">Sign in to continue</p>
              </div>
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="login-email" className="text-sm font-medium text-white/90">Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      id="login-email"
                      type="email"
                      placeholder="Enter your email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label htmlFor="login-password" className="text-sm font-medium text-white/90">Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      id="login-password"
                      type="password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>

                {authError && (
                  <p className="text-sm text-red-400">{authError}</p>
                )}

                <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
                  <LogIn className="h-4 w-4" />
                  {isSubmitting ? "Signing in..." : "Sign In"}
                </Button>
              </form>
              <p className="text-center text-sm text-white/60">
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("register")}
                  className="text-white underline underline-offset-2 hover:text-white/80"
                >
                  Register
                </button>
              </p>
            </>
          )}

          {/* --- REGISTER MODE --- */}
          {authMode === "register" && (
            <>
              <div className="space-y-2 text-center">
                <h1 className="text-3xl tracking-tight text-white">Create Account</h1>
                <p className="text-sm text-white/60">A few details to get started</p>
              </div>
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-white/90">Name *</label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <Input
                        type="text"
                        placeholder="First name"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <Input
                        type="text"
                        placeholder="Surname"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <label htmlFor="reg-email" className="text-sm font-medium text-white/90">Email *</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      id="reg-email"
                      type="email"
                      placeholder="Enter your email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label htmlFor="reg-password" className="text-sm font-medium text-white/90">Password *</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <Input
                        id="reg-password"
                        type="password"
                        placeholder="Min 8 chars"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="reg-confirm" className="text-sm font-medium text-white/90">Confirm *</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <Input
                        id="reg-confirm"
                        type="password"
                        placeholder="Confirm password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label htmlFor="reg-phone" className="text-sm font-medium text-white/90">Phone</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <Input
                        id="reg-phone"
                        type="tel"
                        placeholder="+1 234 567 890"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="reg-dob" className="text-sm font-medium text-white/90">Date of Birth</label>
                    <div className="relative">
                      <Calendar className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <Input
                        id="reg-dob"
                        type="date"
                        value={dateOfBirth}
                        onChange={(e) => setDateOfBirth(e.target.value)}
                        className={inputClass}
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <label htmlFor="reg-nationality" className="text-sm font-medium text-white/90">Nationality</label>
                  <div className="relative">
                    <Globe className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      id="reg-nationality"
                      type="text"
                      placeholder="e.g. British"
                      value={nationality}
                      onChange={(e) => setNationality(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>

                {authError && (
                  <p className="text-sm text-red-400">{authError}</p>
                )}

                <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
                  <UserPlus className="h-4 w-4" />
                  {isSubmitting ? "Creating account..." : "Create Account"}
                </Button>
              </form>
              <p className="text-center text-sm text-white/60">
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="text-white underline underline-offset-2 hover:text-white/80"
                >
                  <ArrowLeft className="mr-1 inline h-3 w-3" />
                  Sign In
                </button>
              </p>
            </>
          )}
        </GlassPanel>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MicToggle — round mic mute/unmute button for the avatar frame
// ---------------------------------------------------------------------------

function MicToggle() {
  const { isMuted } = useLiveKitAvatarContext()
  const { startListening, stopListening } = useAvatarActions()

  const toggle = useCallback(() => {
    if (isMuted) {
      startListening()
    } else {
      stopListening()
    }
  }, [isMuted, startListening, stopListening])

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 backdrop-blur-md shadow-lg transition-colors hover:bg-white/20"
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
  const { isAuthenticated, userProfile, returningUserData, firebaseUser } = useAuth()
  const { profile, journeyStage } = useUserProfileContext()
  const [introComplete, setIntroComplete] = useState(false)
  const [ue5Ready, setUe5Ready] = useState(false)
  const [ue5Hidden, setUe5Hidden] = useState(false)
  // Stage 5: LiveKit session state — replaces the HeyGen sessionToken/context_id.
  // The /api/start-livekit-session route returns { token, roomName, participantName, serverUrl }.
  // We drop contextId/ephemeral-context-cleanup entirely since LiveKit has no
  // equivalent concept; the unload handler below no longer needs to cleanup HeyGen.
  const [token, setToken] = useState<string | null>(null)
  const [roomName, setRoomName] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const sessionUserIdRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // --- Stream config ---
  const streamMode = process.env.NEXT_PUBLIC_STREAM_MODE || "local"
  const isVagonMode = streamMode === "vagon"

  // Vagon machine lifecycle (only active in vagon mode)
  const vagon = useVagonSession(isVagonMode)
  const vagonMachineIdRef = useRef<string | null>(null)
  // Keep ref in sync so beforeunload can access it
  useEffect(() => {
    vagonMachineIdRef.current = vagon.machineId
  }, [vagon.machineId])

  // Cleanup Vagon machine on tab close / navigation away.
  // (LiveKit path has no ephemeral-context cleanup — the HeyGen block was removed.)
  useEffect(() => {
    const handleUnload = () => {
      // Stop Vagon machine via server-side proxy (beacon can't set HMAC headers)
      if (vagonMachineIdRef.current) {
        navigator.sendBeacon(
          "/api/stop-vagon-machine",
          new Blob(
            [JSON.stringify({ machine_id: vagonMachineIdRef.current })],
            { type: "application/json" },
          ),
        )
      }
    }
    window.addEventListener("beforeunload", handleUnload)
    return () => {
      window.removeEventListener("beforeunload", handleUnload)
      // Also stop on React unmount (SPA navigation)
      if (vagonMachineIdRef.current) {
        void vagon.stop()
      }
    }
  }, [vagon.stop])

  // The overlay stays until introComplete — auth state changes mid-intro don't dismiss it
  const showLoginOverlay = !introComplete

  // Lightweight UE5 listener — detect the first incoming message
  const handleFirstUE5Message = useCallback(() => setUe5Ready(true), [])
  useUE5WebSocket({
    onMessage: handleFirstUE5Message,
    onUnitSelected: handleFirstUE5Message,
  })

  // Fetch LiveKit access token once UE5 is ready, user is authenticated, AND intro is complete.
  // Reset if the user identity changes (logout + re-login on same page mount).
  //
  // Stage 5: the request body is the same ContextInput shape the HeyGen route
  // accepts — `agent/system-prompt.ts` consumes it identically to
  // `lib/avatar-context-builder.ts` on the legacy path. The response shape is
  // intentionally different (`{token, roomName, participantName, serverUrl}`
  // instead of `{session_token, session_id, context_id}`) and is consumed
  // directly by <LiveKitAvatarContextProvider/> below.
  useEffect(() => {
    if (!ue5Ready || !introComplete || !isAuthenticated || !userProfile) return
    const currentUid = firebaseUser?.uid ?? null
    if (sessionUserIdRef.current === currentUid) return
    sessionUserIdRef.current = currentUid
    const startLiveKitSession = async () => {
      try {
        const body = {
          identity: userProfile,
          personality: returningUserData?.personality ?? null,
          preferences: returningUserData?.preferences ?? null,
          loyalty: returningUserData?.loyalty ?? null,
        }
        const res = await fetch("/api/start-livekit-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const resp = await res.json().catch(() => ({}))
          throw new Error(resp?.error ?? "Failed to start LiveKit session")
        }
        const data = await res.json()
        setToken(data.token)
        setRoomName(data.roomName ?? null)
        setServerUrl(data.serverUrl ?? null)
      } catch (err) {
        setError((err as Error).message)
      }
    }
    startLiveKitSession()
  }, [ue5Ready, introComplete, isAuthenticated, userProfile, returningUserData, firebaseUser])

  // --- Stream config (streamMode & isVagonMode declared earlier) ---
  const streamUrl = isVagonMode
    ? (vagon.connectionLink ?? "")
    : (process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1")
  const hasStream = isVagonMode
    ? !!vagon.connectionLink
    : (!!streamUrl && streamUrl !== "about:blank")
  const iframeAllow = isVagonMode
    ? "microphone *; clipboard-read *; clipboard-write *; encrypted-media *; fullscreen *"
    : "autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"

  const handleIntroComplete = useCallback(() => setIntroComplete(true), [])

  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden">
      {/* UE5 Pixel Stream — loads immediately, behind everything */}
      {hasStream && !ue5Hidden ? (
        <iframe
          id={isVagonMode ? "vagonFrame" : undefined}
          title="Vagon UE5 Stream"
          src={streamUrl}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 min-w-full min-h-full w-[max(100vw,calc(100vh*16/9))] h-[max(100vh,calc(100vw*9/16))]"
          allow={iframeAllow}
        />
      ) : !ue5Hidden ? (
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-black to-slate-950">
          {!isVagonMode && (
            <div className="flex items-center justify-center h-full text-white/70">
              Set NEXT_PUBLIC_VAGON_STREAM_URL to render the live UE5 background here.
            </div>
          )}
        </div>
      ) : null}

      {/* Login intro overlay — sits on top of iframe, hides UE5 while loading */}
      {showLoginOverlay && <LoginOverlay onComplete={handleIntroComplete} skipIntro={!isVagonMode} />}

      {/* End experience overlay — farewell message over intro video */}
      {journeyStage === "END_EXPERIENCE" && <EndExperienceOverlay firstName={profile.firstName} />}

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
          {token && (
            <LiveKitAvatarContextProvider
              token={token}
              serverUrl={serverUrl ?? undefined}
              roomName={roomName ?? undefined}
            >
              <HomePageContent onHideUE5Stream={() => setUe5Hidden(true)} />
            </LiveKitAvatarContextProvider>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// HomePageContent — thin layout shell (all hooks available)
// ---------------------------------------------------------------------------

function HomePageContent({ onHideUE5Stream }: { onHideUE5Stream: () => void }) {
  const { selectHotel, selectedHotel } = useApp()
  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const emit = useEmit()
  const { sessionState, sessionRef } = useLiveKitAvatarContext()
  useDebugLogger()
  const { writeEndOfSessionSnapshot } = useIncrementalPersistence({
    useContext: useLiveKitAvatarContext,
    useProfile: useUserProfile,
  })
  const { returningUserData } = useAuth()

  // --- Pre-populate profile from returning user's persisted preferences ---
  //
  // Stage 6 Phase C Fix 1: hydrate partySize / guestComposition / travelPurpose
  // for returning users so the state_snapshot is accurate from the start.
  // Without this, the LLM's persona greeting ("Will it be the 4 of you again?")
  // contradicts state_snapshot's partySize: 1, and room recommendations are
  // made for a party of 1 even though the persona knows it's a family of 4.
  //
  // Dates (startDate/endDate) and roomAllocation are intentionally NOT
  // hydrated — they are session-specific and must be collected through
  // conversation. profileCollectionAwaiting() in journey-machine.ts gates
  // stage advancement on dates being present, so the journey will still stay
  // in PROFILE_COLLECTION until the user provides them.
  const hasHydratedRef = useRef(false)
  useEffect(() => {
    if (hasHydratedRef.current || !returningUserData) return
    hasHydratedRef.current = true
    const { personality, preferences } = returningUserData
    const typical = preferences?.typicalGuestComposition ?? null
    const partySize = typical ? typical.adults + typical.children : undefined
    const guestComposition = typical
      ? { adults: typical.adults, children: typical.children }
      : undefined
    const travelPurpose = personality?.travelPurposes?.[0] ?? undefined
    updateProfile({
      interests: personality?.interests ?? [],
      budgetRange: personality?.budgetTendency ?? undefined,
      dietaryRestrictions: personality?.dietaryRestrictions ?? [],
      accessibilityNeeds: personality?.accessibilityNeeds ?? [],
      amenityPriorities: preferences?.preferredAmenities ?? [],
      ...(partySize !== undefined ? { familySize: partySize } : {}),
      ...(guestComposition ? { guestComposition } : {}),
      ...(travelPurpose ? { travelPurpose } : {}),
    })
  }, [returningUserData, updateProfile])

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

  const computedPlan = useMemo(
    () => getRecommendedRoomPlan(
      rooms,
      profile.familySize,
      profile.guestComposition,
      profile.travelPurpose,
      profile.budgetRange,
      profile.distributionPreference,
      profile.roomAllocation,
    ),
    [rooms, profile.familySize, profile.guestComposition, profile.travelPurpose, profile.budgetRange, profile.distributionPreference, profile.roomAllocation],
  )

  // Mutable plan override — set by dynamic adjustments (budget, compact, explicit composition)
  // Falls back to computedPlan when null. Reset when the rooms panel closes.
  const [planOverride, setPlanOverride] = useState<import("@/lib/hotel-data").RoomPlan | null>(null)
  const recommendedPlan = planOverride ?? computedPlan

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

  // --- Room plan update callback (dynamic adjustments from voice) ---
  const handleUpdateRoomPlan = useCallback((plan: import("@/lib/hotel-data").RoomPlan) => {
    setPlanOverride(plan)
  }, [])

  // --- End experience callbacks ---
  const handleStopAvatar = useCallback(() => {
    // LiveKit: disconnect the Room. The provider's internal
    // <LiveKitRoom connect={true}> will NOT auto-reconnect because the
    // parent HomePage clears the `token` state before this path runs
    // in the reducer's STOP_AVATAR effect (4-second delay lets the
    // farewell speech play). For /home-v2 we call disconnect directly.
    sessionRef.current?.disconnect()
  }, [sessionRef])

  // --- Stage 5 LiveKit bridges ----------------------------------------
  //
  // useStateSyncBridge watches profile/journey/hotel state + the
  // EventBus and publishes state_snapshot / ui_event / narration_nudge
  // messages to the agent. It returns an onSpeak callback that routes
  // useJourney's SPEAK effects to narration_nudge messages instead of
  // literal repeat() calls on the avatar session.
  //
  // useToolCallBridge subscribes to tool_call messages from the agent
  // and translates them into EventBus emits or page-level callbacks so
  // the existing orchestration handles voice-driven actions exactly as
  // if they were tap/click interactions.
  //
  // Both are safe no-ops before the room is connected.
  const { onSpeak } = useStateSyncBridge({ enabled: true })

  const handleEndExperience = useCallback(() => {
    // Dispatch the end-experience intent into the journey reducer.
    // We capture this via a lazy ref below — journeyDispatch isn't yet
    // declared at this point in the render (it's the very next hook),
    // but the bridge stores the callback until its effect runs.
    journeyDispatchRef.current?.({
      type: "USER_INTENT",
      intent: { type: "END_EXPERIENCE" },
    })
  }, [])

  const handleReturnToLounge = useCallback(() => {
    journeyDispatchRef.current?.({
      type: "USER_INTENT",
      intent: { type: "RETURN_TO_LOUNGE" },
    })
  }, [])

  const journeyDispatchRef = useRef<((action: import("@/lib/orchestrator").JourneyAction) => void) | null>(null)

  useToolCallBridge({
    enabled: true,
    onOpenPanel: handleOpenPanel,
    onEndExperience: handleEndExperience,
    onReturnToLounge: handleReturnToLounge,
    selectedHotelSlug: selectedHotel,
  })

  // --- Avatar backend override for useJourney ---
  // Maps lib/livekit hooks into the shape useJourney expects via
  // options.avatarHooks. Default-path hooks (lib/liveavatar) are never
  // called because this override wins — which is the whole point of
  // the Stage 5 seam. The object is memoized so useJourney sees a
  // stable reference.
  const avatarHooks = useMemo<UseJourneyAvatarHooks>(
    () => ({
      useContext: useLiveKitAvatarContext,
      useActions: () => useAvatarActions("FULL"),
      useProfile: useUserProfile,
    }),
    [],
  )

  // --- Journey orchestrator (runs as a hook, not a component) ---
  const { dispatch: journeyDispatch } = useJourney({
    onOpenPanel: handleOpenPanel,
    onClosePanels: handleClosePanels,
    onUE5Command: ue5.sendCommand,
    onResetToDefault: handleResetToDefault,
    onFadeTransition: ue5.fadeTransition,
    onSelectHotel: handleAutoSelectHotel,
    onUpdateRoomPlan: handleUpdateRoomPlan,
    onStopAvatar: handleStopAvatar,
    onHideUE5Stream,
    amenities,
    rooms,
    onSpeak,
    avatarHooks,
  })

  // Hand journeyDispatch to the ref used by handleEndExperience.
  useEffect(() => {
    journeyDispatchRef.current = journeyDispatch
  }, [journeyDispatch])

  // --- End-of-session snapshot on LiveKit disconnect ---
  useEffect(() => {
    if (sessionState === SessionState.DISCONNECTED) {
      writeEndOfSessionSnapshot()
    }
  }, [sessionState, writeEndOfSessionSnapshot])

  // NOTE: visibilitychange persistence is now handled inside useIncrementalPersistence.
  // Data is written incrementally throughout the session, so closing the tab only
  // needs to flush the endedAt timestamp and any pending debounced profile writes.

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
    setPlanOverride(null) // reset dynamic plan override when panel closes
    ue5.resetToDefault()
  }, [ue5])

  // --- Sun state handler ---
  const handleSunStateChange = useCallback((value: SunState) => {
    ue5.changeSunPosition(value)
  }, [ue5])

  const showDestinationsOverlay = journeyStage === "DESTINATION_SELECT"

  // -----------------------------------------------------------------------
  // Render — panels are rendered outside the pointer-events-none wrapper
  // so they sit as siblings of the iframe and receive events properly.
  // -----------------------------------------------------------------------
  return (
    <>
      <div className="pointer-events-none relative min-h-screen w-full overflow-hidden">
        {/* Fade overlay for scene transitions */}
        {ue5.showFadeOverlay && (
          <div
            className={`pointer-events-none absolute inset-0 z-[5] bg-black transition-opacity duration-1000 ease-linear ${ue5.isFadeOpaque ? "opacity-100" : "opacity-0"}`}
          />
        )}

        {/* Unit detail panel */}
        <UnitDetailPanel unit={ue5.selectedUnit} />

        <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between px-6 pb-10 pt-12 sm:px-10">
          <div />

          {/* Avatar control panel */}
          <div className="mt-auto pointer-events-auto">
            <div className="inline-flex items-stretch rounded-[20px] border border-white/25 bg-gradient-to-br from-white/20 via-white/10 to-white/5 shadow-[0_20px_60px_-28px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
              {/* Avatar — 5px padding top/left/bottom, flush right edge */}
              <div className="p-[5px] pr-0">
                <div
                  className="relative overflow-hidden rounded-[16px] bg-black shadow-2xl"
                  style={{ width: 210, aspectRatio: "1 / 1.25" }}
                >
                  <LiveKitAvatarPlayer fit="cover" />
                </div>
              </div>

              {/* Right body — buttons */}
              <div className="flex flex-col items-center justify-between py-4 px-[15px] min-w-[70px]">
                <div />
                {selectedHotel && journeyStage === "HOTEL_EXPLORATION" && (
                  <SunToggle value={ue5.sunState} onChange={handleSunStateChange} />
                )}
                <MicToggle />
              </div>
            </div>
          </div>
        </div>

        {/* Profile Sync (functional, no UI — must run in all modes) */}
        <ProfileSync useProfileHook={useUserProfile} />

        {/* Debug HUD (floating, local dev only) */}
        {streamMode === "local" && (
          <div className="fixed top-4 right-4 z-30 space-y-3 pointer-events-none">
            <DebugHud />
          </div>
        )}
      </div>

      {/* --- Panels rendered outside the wrapper, as siblings of the iframe --- */}

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
        recommendedPlan={recommendedPlan}
      />
    </>
  )
}
