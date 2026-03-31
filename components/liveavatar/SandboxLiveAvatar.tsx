"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { AgentEventsEnum, SessionState } from "@heygen/liveavatar-web-sdk"
import { ChevronDown } from "lucide-react"
import { LiveAvatarContextProvider, useLiveAvatarContext, useSession, useUserProfile } from "@/lib/liveavatar"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useUserProfileContext } from "@/lib/context"

export const useDebugLogger = () => {
  const { profile: derivedProfile, userMessages, isExtracting } = useUserProfile()
  const { profile, journeyStage } = useUserProfileContext()

  useEffect(() => {
    console.log("[Omnam Debug]", {
      journeyStage,
      contextProfile: {
        name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null,
        email: profile.email || null,
        startDate: profile.startDate || null,
        endDate: profile.endDate || null,
        familySize: profile.familySize ?? null,
        destination: profile.destination || null,
        interests: profile.interests,
        travelPurpose: profile.travelPurpose || null,
        budgetRange: profile.budgetRange || null,
      },
      avatarDerived: {
        name: derivedProfile.name ?? null,
        partySize: derivedProfile.partySize ?? null,
        destination: derivedProfile.destination ?? null,
        startDate: derivedProfile.startDate?.toISOString() ?? null,
        endDate: derivedProfile.endDate?.toISOString() ?? null,
        interests: derivedProfile.interests,
        travelPurpose: derivedProfile.travelPurpose ?? null,
        budgetRange: derivedProfile.budgetRange ?? null,
        isExtracting,
      },
      recentUtterances: userMessages.slice(-3).map((m) => ({
        message: m.message,
        timestamp: m.timestamp,
      })),
    })
  }, [profile, derivedProfile, userMessages, isExtracting, journeyStage])
}

export const DebugHud = () => {
  const { profile: derivedProfile, userMessages, isExtracting } = useUserProfile()
  const { profile, journeyStage } = useUserProfileContext()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white/12 text-white text-xs sm:text-sm p-3 rounded-xl space-y-2 max-w-sm pointer-events-auto border border-white/15 backdrop-blur-md shadow-lg select-none">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <div className="font-semibold text-white">User Profile (context)</div>
          <div className="text-[10px] px-2 py-0.5 rounded bg-white/10">{journeyStage}</div>
        </div>
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {!expanded ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-white/80">
          <span>Name: {[profile.firstName, profile.lastName].filter(Boolean).join(" ") || "—"}</span>
          <span>Dest: {profile.destination || derivedProfile.destination || "—"}</span>
          <span>
            Dates: {derivedProfile.startDate && derivedProfile.endDate
              ? `${derivedProfile.startDate.toLocaleDateString()}–${derivedProfile.endDate.toLocaleDateString()}`
              : "—"}
          </span>
          <span>Guests: {derivedProfile.partySize ?? profile.familySize ?? "—"}</span>
        </div>
      ) : (
        <>
          <div>Name: {[profile.firstName, profile.lastName].filter(Boolean).join(" ") || "—"}</div>
          <div>Email: {profile.email || "—"}</div>
          <div>Start date: {profile.startDate ? new Date(profile.startDate).toLocaleDateString() : "—"}</div>
          <div>End date: {profile.endDate ? new Date(profile.endDate).toLocaleDateString() : "—"}</div>
          <div>Family size: {profile.familySize ?? "—"}</div>
          <div>Destination: {profile.destination || "—"}</div>
          <div>Interests: {profile.interests.length ? profile.interests.join(", ") : "—"}</div>
          <div>Travel purpose: {profile.travelPurpose || "—"}</div>
          <div>Budget: {profile.budgetRange || "—"}</div>
          <div className="pt-1 border-t border-white/20">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">Avatar Derived</span>
              {isExtracting && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/30 text-blue-200 animate-pulse">
                  AI extracting...
                </span>
              )}
            </div>
          </div>
          <div>Name: {derivedProfile.name ?? "—"}</div>
          <div>Party size: {derivedProfile.partySize ?? "—"}</div>
          <div>Destination: {derivedProfile.destination ?? "—"}</div>
          <div>Dates: {derivedProfile.startDate && derivedProfile.endDate
            ? `${derivedProfile.startDate.toLocaleDateString()} - ${derivedProfile.endDate.toLocaleDateString()}`
            : "—"}</div>
          <div>Interests: {derivedProfile.interests.length ? derivedProfile.interests.join(", ") : "—"}</div>
          {derivedProfile.travelPurpose && <div>Purpose: {derivedProfile.travelPurpose}</div>}
          {derivedProfile.budgetRange && <div>Budget: {derivedProfile.budgetRange}</div>}
          {userMessages.length > 0 && (
            <div className="pt-1 border-t border-white/20">
              <div className="font-semibold text-white">Recent utterances ({userMessages.length})</div>
              <ul className="space-y-1 text-white/80">
                {userMessages.slice(-3).map((m, idx) => (
                  <li key={`${m.timestamp}-${idx}`} className="truncate max-w-[280px]">
                    "{m.message}"
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export const SandboxSessionPlayer = ({ fit }: { fit: "contain" | "cover" }) => {
  const [muted, setMuted] = useState(false)
  const { sessionState, isStreamReady, startSession, attachElement, stopSession } = useSession()
  const { repeat, interrupt } = useAvatarActions("FULL")
  const { profile } = useUserProfileContext()
  const { sessionRef } = useLiveAvatarContext()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasWelcomedRef = useRef(false)
  const removeFirstSpeakGuardRef = useRef<(() => void) | null>(null)
  const frameRequestRef = useRef<number | null>(null)
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null)

  // // Guard to kill any default first utterance from the avatar (HeyGen welcome, etc.)
  // useEffect(() => {
  //   const session = sessionRef.current
  //   if (!session) return

  //   const handleFirstSpeak = () => {
  //     session.interrupt()
  //     if (removeFirstSpeakGuardRef.current) {
  //       removeFirstSpeakGuardRef.current()
  //       removeFirstSpeakGuardRef.current = null
  //     }
  //   }

  //   session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, handleFirstSpeak)
  //   removeFirstSpeakGuardRef.current = () => session.removeListener(AgentEventsEnum.AVATAR_SPEAK_STARTED, handleFirstSpeak)

  //   return () => removeFirstSpeakGuardRef.current?.()
  // }, [sessionRef])

  useEffect(() => {
    if (sessionState === SessionState.INACTIVE) {
      startSession()?.catch(() => undefined)
    }
  }, [sessionState, startSession])

  // useEffect(() => {
  //   if (sessionState === SessionState.CONNECTED && !hasWelcomedRef.current) {
  //     hasWelcomedRef.current = true
  //     const firstName = profile.firstName?.trim() || "there"
  //     // Drop the guard so our own greeting isn't interrupted
  //     removeFirstSpeakGuardRef.current?.()
  //     removeFirstSpeakGuardRef.current = null
  //     // interrupt()?.catch(() => undefined)

  //     interrupt()
  //     enableAudio()
  //     repeat(
  //       `Hello ${firstName}, I'm Ava from the Omnam Group. I'll be your AI assistant today. I'll collect a few details and guide you to the best property and room for your stay. Can you briefly tell me where would you like to travel, in which dates and how many guests will be travelling with you?`,
  //     ).catch(() => undefined)
  //   }
  // }, [interrupt, profile.firstName, repeat, sessionState])

  useEffect(() => {
    if (isStreamReady && videoRef.current) {
      attachElement(videoRef.current)
      videoRef.current.play().catch(() => undefined)
    }
  }, [attachElement, isStreamReady])

  // When metadata is ready, size the canvas to the video for crisp output
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleLoadedMetadata = () => {
      if (!canvasRef.current) return
      const w = video.videoWidth || video.clientWidth
      const h = video.videoHeight || video.clientHeight
      if (!w || !h) return
      canvasRef.current.width = w
      canvasRef.current.height = h
      setDimensions({ w, h })
    }

    video.addEventListener("loadedmetadata", handleLoadedMetadata)
    return () => video.removeEventListener("loadedmetadata", handleLoadedMetadata)
  }, [])

  // Lightweight chroma-key pass on each frame
  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return

    const GREEN_THRESHOLD = 70      // minimum green value to consider
    const GREEN_DOMINANCE = 1.25    // how much stronger green must be than red/blue

    const render = () => {
      if (!dimensions) {
        frameRequestRef.current = requestAnimationFrame(render)
        return
      }

      ctx.drawImage(video, 0, 0, dimensions.w, dimensions.h)
      const frame = ctx.getImageData(0, 0, dimensions.w, dimensions.h)
      const data = frame.data

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]

        // Simple chroma key: drop pixels where green dominates clearly
        if (g > GREEN_THRESHOLD && g > r * GREEN_DOMINANCE && g > b * GREEN_DOMINANCE) {
          data[i + 3] = 0 // set alpha to 0
        }
      }

      ctx.putImageData(frame, 0, 0)
      frameRequestRef.current = requestAnimationFrame(render)
    }

    frameRequestRef.current = requestAnimationFrame(render)

    return () => {
      if (frameRequestRef.current) {
        cancelAnimationFrame(frameRequestRef.current)
      }
    }
  }, [dimensions])

  useEffect(() => {
    return () => {
      stopSession()?.catch(() => undefined)
    }
  }, [stopSession])


  return (
    <div className="w-full h-full relative">
      <video
        ref={videoRef}
        autoPlay
        muted={muted}
        playsInline
        className="absolute inset-0 h-full w-full opacity-0 pointer-events-none"
      />
      <canvas
        ref={canvasRef}
        className={`w-full h-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
      />
    </div>
  )
}

type SandboxLiveAvatarProps = {
  sessionToken: string
  fit?: "contain" | "cover"
  renderHud?: ReactNode
}

export const SandboxLiveAvatar = ({ sessionToken, fit = "contain", renderHud }: SandboxLiveAvatarProps) => {
  return (
    <LiveAvatarContextProvider sessionAccessToken={sessionToken}>
      <>
        <div className="relative w-full h-full">
          <SandboxSessionPlayer fit={fit} />
        </div>
        {renderHud}
      </>
    </LiveAvatarContextProvider>
  )
}

