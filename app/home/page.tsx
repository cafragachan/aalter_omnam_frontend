"use client"

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Mail, Lock, LogIn, User, Phone, Calendar, UserPlus, ArrowLeft, Globe } from "lucide-react"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/lib/auth-context"
import { useUserProfileContext } from "@/lib/context"
import HomePageContentRealtime from "./HomePageContentRealtime"

// ---------------------------------------------------------------------------
// /home — thin shell: auth + login overlay + UE5 iframe, then the realtime brain
// (HomePageContentRealtime). The legacy HeyGen-FULL + useJourney path was removed
// in D.3; the realtime path is the only execution path now.
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
  const { updateProfile } = useUserProfileContext()

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
      setShowForm(false)
      setTimeout(() => {
        setPhase("farewell")
        setFarewellIndex(0)
        setTyping(true)
      }, 400)
    },
    [updateProfile],
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
// HomePage — shell: UE5 iframe + login overlay → realtime brain
// ---------------------------------------------------------------------------

export default function HomePage() {
  const { isAuthenticated } = useAuth()
  const [introComplete, setIntroComplete] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const streamMode = process.env.NEXT_PUBLIC_STREAM_MODE || "local"
  const isVagonMode = streamMode === "vagon"
  const showLoginOverlay = !introComplete

  const handleIframeMouseEnter = useCallback(() => {
    iframeRef.current?.focus()
  }, [])
  const handleIntroComplete = useCallback(() => setIntroComplete(true), [])

  const streamUrl = isVagonMode
    ? "https://streams.vagon.io/streams/e92ad7d9-0510-4246-bdac-8fbedb5653ed?newSession=true"
    : process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = !!streamUrl && streamUrl !== "about:blank"
  const iframeAllow = isVagonMode
    ? "microphone *; clipboard-read *; clipboard-write *; encrypted-media *; fullscreen *"
    : "autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"

  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden select-none">
      {/* UE5 Pixel Stream — loads immediately, behind everything */}
      {hasStream ? (
        <iframe
          ref={iframeRef}
          id={isVagonMode ? "vagonFrame" : undefined}
          title="Vagon UE5 Stream"
          src={streamUrl}
          tabIndex={0}
          onMouseEnter={handleIframeMouseEnter}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 min-w-full min-h-full w-[max(100vw,calc(100vh*16/9))] h-[max(100vh,calc(100vw*9/16))] outline-none"
          allow={iframeAllow}
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-black to-slate-950">
          {!isVagonMode && (
            <div className="flex items-center justify-center h-full text-white/70">
              Set NEXT_PUBLIC_VAGON_STREAM_URL to render the live UE5 background here.
            </div>
          )}
        </div>
      )}

      {/* Login intro overlay — sits on top of iframe, hides UE5 while loading */}
      {showLoginOverlay && <LoginOverlay onComplete={handleIntroComplete} skipIntro={!isVagonMode} />}

      {/* The realtime brain, once intro completes and the guest is authenticated */}
      {introComplete && isAuthenticated && <HomePageContentRealtime />}
    </div>
  )
}
