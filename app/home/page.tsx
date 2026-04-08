"use client"

import type React from "react"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Mic, MicOff, Lock, Mail, LogIn, User, Phone, Calendar, UserPlus, ArrowLeft, Globe } from "lucide-react"
import { DebugHud, SandboxSessionPlayer, useDebugLogger } from "@/components/liveavatar/SandboxLiveAvatar"
import { LiveAvatarContextProvider, useLiveAvatarContext } from "@/lib/liveavatar"
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
import { useJourney } from "@/lib/orchestrator"
import { useUE5Bridge } from "@/lib/ue5/bridge"
import { useVagonSession } from "@/lib/ue5/useVagonSession"
import { hotels, getHotelBySlug, getRoomsByHotelId, getAmenitiesByHotelId, getRecommendedRoomId, getRecommendedRoomPlan } from "@/lib/hotel-data"
import type { Room } from "@/lib/hotel-data"
import { useUE5WebSocket } from "@/lib/useUE5WebSocket"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useIncrementalPersistence } from "@/lib/firebase/useIncrementalPersistence"
import { SessionState } from "@heygen/liveavatar-web-sdk"

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
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [contextId, setContextId] = useState<string | null>(null)
  const contextIdRef = useRef<string | null>(null)
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

  // Cleanup ephemeral context + Vagon machine on tab close / navigation away
  useEffect(() => {
    const handleUnload = () => {
      // Cleanup HeyGen ephemeral context
      if (contextIdRef.current) {
        navigator.sendBeacon(
          "/api/cleanup-context",
          new Blob(
            [JSON.stringify({ context_id: contextIdRef.current })],
            { type: "application/json" },
          ),
        )
      }

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

  // Fetch HeyGen session token once UE5 is ready, user is authenticated, AND intro is complete.
  // Reset if the user identity changes (logout + re-login on same page mount).
  useEffect(() => {
    if (!ue5Ready || !introComplete || !isAuthenticated || !userProfile) return
    const currentUid = firebaseUser?.uid ?? null
    if (sessionUserIdRef.current === currentUid) return
    sessionUserIdRef.current = currentUid
    const startSandboxSession = async () => {
      try {
        const body = {
          identity: userProfile,
          personality: returningUserData?.personality ?? null,
          preferences: returningUserData?.preferences ?? null,
          loyalty: returningUserData?.loyalty ?? null,
        }
        const res = await fetch("/api/start-sandbox-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const resp = await res.json().catch(() => ({}))
          throw new Error(resp?.error ?? "Failed to start sandbox session")
        }
        const data = await res.json()
        setSessionToken(data.session_token)
        const newContextId = data.context_id ?? null
        setContextId(newContextId)
        contextIdRef.current = newContextId
      } catch (err) {
        setError((err as Error).message)
      }
    }
    startSandboxSession()
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
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 via-black to-slate-950 text-white/70">
          Set NEXT_PUBLIC_VAGON_STREAM_URL to render the live UE5 background here.
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
          {sessionToken && (
            <LiveAvatarContextProvider sessionAccessToken={sessionToken}>
              <HomePageContent ephemeralContextId={contextId} onHideUE5Stream={() => setUe5Hidden(true)} />
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

function HomePageContent({ ephemeralContextId, onHideUE5Stream }: { ephemeralContextId: string | null; onHideUE5Stream: () => void }) {
  const { selectHotel, selectedHotel } = useApp()
  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const emit = useEmit()
  const { sessionState, sessionRef } = useLiveAvatarContext()
  useDebugLogger()
  const { writeEndOfSessionSnapshot } = useIncrementalPersistence()
  const { returningUserData } = useAuth()

  // --- Pre-populate profile from returning user's persisted preferences ---
  const hasHydratedRef = useRef(false)
  useEffect(() => {
    if (hasHydratedRef.current || !returningUserData) return
    hasHydratedRef.current = true
    const { personality, preferences } = returningUserData
    const comp = preferences?.typicalGuestComposition ?? undefined
    updateProfile({
      interests: personality?.interests ?? [],
      travelPurpose: personality?.travelPurposes?.[0] ?? undefined,
      budgetRange: personality?.budgetTendency ?? undefined,
      dietaryRestrictions: personality?.dietaryRestrictions ?? [],
      accessibilityNeeds: personality?.accessibilityNeeds ?? [],
      amenityPriorities: preferences?.preferredAmenities ?? [],
      guestComposition: comp,
      familySize: comp ? comp.adults + comp.children : undefined,
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
    sessionRef.current?.stop()
  }, [sessionRef])

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
  })

  // --- End-of-session snapshot + cleanup ephemeral context on HeyGen disconnect ---
  useEffect(() => {
    if (sessionState === SessionState.DISCONNECTED) {
      writeEndOfSessionSnapshot()
      if (ephemeralContextId) {
        fetch("/api/cleanup-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context_id: ephemeralContextId }),
        }).catch(() => {
          // Non-critical — fire and forget
        })
      }
    }
  }, [sessionState, writeEndOfSessionSnapshot, ephemeralContextId])

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
                  <SandboxSessionPlayer fit="cover" />
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
        <ProfileSync />

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
