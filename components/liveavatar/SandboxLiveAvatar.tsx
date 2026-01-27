"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { AgentEventsEnum, SessionState } from "@heygen/liveavatar-web-sdk"
import { ChevronDown } from "lucide-react"
import { LiveAvatarContextProvider, useLiveAvatarContext, useSession, useUserProfile } from "@/lib/liveavatar"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useUserProfileContext } from "@/lib/context"

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

const SandboxSessionPlayer = ({ fit }: { fit: "contain" | "cover" }) => {
  const [muted, setMuted] = useState(true)
  const { sessionState, isStreamReady, startSession, attachElement, stopSession } = useSession()
  const { repeat, interrupt } = useAvatarActions("FULL")
  const { profile } = useUserProfileContext()
  const { sessionRef } = useLiveAvatarContext()
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasWelcomedRef = useRef(false)
  const removeFirstSpeakGuardRef = useRef<(() => void) | null>(null)

  // Guard to kill any default first utterance from the avatar (HeyGen welcome, etc.)
  useEffect(() => {
    const session = sessionRef.current
    if (!session) return

    const handleFirstSpeak = () => {
      session.interrupt()
      if (removeFirstSpeakGuardRef.current) {
        removeFirstSpeakGuardRef.current()
        removeFirstSpeakGuardRef.current = null
      }
    }

    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, handleFirstSpeak)
    removeFirstSpeakGuardRef.current = () => session.removeListener(AgentEventsEnum.AVATAR_SPEAK_STARTED, handleFirstSpeak)

    return () => removeFirstSpeakGuardRef.current?.()
  }, [sessionRef])

  useEffect(() => {
    if (sessionState === SessionState.INACTIVE) {
      startSession()?.catch(() => undefined)
    }
  }, [sessionState, startSession])

  useEffect(() => {
    if (sessionState === SessionState.CONNECTED && !hasWelcomedRef.current) {
      hasWelcomedRef.current = true
      const firstName = profile.firstName?.trim() || "there"
      // Drop the guard so our own greeting isn't interrupted
      removeFirstSpeakGuardRef.current?.()
      removeFirstSpeakGuardRef.current = null
      // interrupt()?.catch(() => undefined)

      interrupt()
      enableAudio()
      repeat(
        `Hello ${firstName}, I'm Ava from the Omnam Group. I'll be your AI assistant today. I'll collect a few details and guide you to the best property and room for your stay. Can you briefly tell me where would you like to travel, in which dates and how many guests will be travelling with you?`,
      ).catch(() => undefined)
    }
  }, [interrupt, profile.firstName, repeat, sessionState])

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
      // onClick={enableAudio}
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

