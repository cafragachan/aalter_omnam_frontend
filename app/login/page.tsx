"use client"

import type React from "react"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { useApp } from "@/lib/store"
import { useUserProfileContext } from "@/lib/context"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { Lock, Mail, LogIn, User, Phone, Calendar } from "lucide-react"

const INTRO_MESSAGES = [
  "Welcome",
  "Your next stay begins here",
  "We'll tailor this experience to you",
  "A few details will help us personalise it",
  "Please sign in to begin",
]

const CHAR_INTERVAL = 120 // fixed 110ms per character (~9 chars/sec, slow deliberate pace)
const HOLD_AFTER_TYPING = 1500 // 1.2s pause showing full text before fading out
const FADE_DURATION = 1 // 0.5s transition between messages

const FAREWELL_MESSAGES = [
  "Thank you",
  "I'll take you to our virtual lounge now",
]

type Phase = "video" | "messages" | "login" | "farewell"

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
      // Skip ahead through spaces — include the space but use a near-zero delay
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

export default function LoginPage() {
  const [phase, setPhase] = useState<Phase>("video")
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
  const router = useRouter()
  const { toast } = useToast()

  // Start messages phase after 2s of video
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
            router.push("/home")
          }
        }
      }, FADE_DURATION)
      return () => clearTimeout(nextTimer)
    }, HOLD_AFTER_TYPING)
    return () => clearTimeout(fadeOutTimer)
  }, [messageIndex, farewellIndex, phase, router])

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
      // Transition to farewell messages before navigating
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

  return (
    <div className="ios-screen relative flex min-h-screen items-center justify-center p-4">
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
