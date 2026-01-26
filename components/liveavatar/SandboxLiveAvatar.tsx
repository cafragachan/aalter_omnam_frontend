"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { SessionState } from "@heygen/liveavatar-web-sdk"
import { LiveAvatarContextProvider, useSession, useUserProfile } from "@/lib/liveavatar"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"

export const DebugHud = () => {
  const { profile, userMessages } = useUserProfile()

  return (
    <div className="bg-white/12 text-white text-xs sm:text-sm p-3 rounded-xl space-y-1 max-w-sm pointer-events-none border border-white/15 backdrop-blur-md shadow-lg">
      <div className="font-semibold text-white">User Profile (live)</div>
      <div>Name: {profile.name ?? "—"}</div>
      <div>Party size: {profile.partySize ?? "—"}</div>
      <div>Destination: {profile.destination ?? "—"}</div>
      <div>Interests: {profile.interests.length ? profile.interests.join(", ") : "—"}</div>
      {userMessages.length > 0 && (
        <div className="pt-1 border-t border-white/20">
          <div className="font-semibold text-white">Recent user utterances</div>
          <ul className="space-y-1 text-white/80">
            {userMessages.slice(-3).map((m, idx) => (
              <li key={`${m.timestamp}-${idx}`}>
                "{m.message}"
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const SandboxSessionPlayer = ({ fit }: { fit: "contain" | "cover" }) => {
  const [muted, setMuted] = useState(true)
  const { sessionState, isStreamReady, startSession, attachElement, stopSession } = useSession()
  const { repeat } = useAvatarActions("FULL")
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasWelcomedRef = useRef(false)

  useEffect(() => {
    if (sessionState === SessionState.INACTIVE) {
      startSession()?.catch(() => undefined)
    }
  }, [sessionState, startSession])

  useEffect(() => {
    if (sessionState === SessionState.CONNECTED && !hasWelcomedRef.current) {
      hasWelcomedRef.current = true
      repeat("Welcome to the Omnam Digital Twin Booking Experience, how can I help you today?").catch(() => undefined)
    }
  }, [repeat, sessionState])

  useEffect(() => {
    if (isStreamReady && videoRef.current) {
      attachElement(videoRef.current)
      videoRef.current.play().catch(() => undefined)
    }
  }, [attachElement, isStreamReady])

  useEffect(() => {
    return () => {
      stopSession()?.catch(() => undefined)
    }
  }, [stopSession])

  const enableAudio = () => {
    if (!videoRef.current) return
    videoRef.current.muted = false
    setMuted(false)
    videoRef.current.play().catch(() => undefined)
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      muted={muted}
      playsInline
      onClick={enableAudio}
      className={`w-full h-full ${fit === "cover" ? "object-cover" : "object-contain"} bg-black`}
    />
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

