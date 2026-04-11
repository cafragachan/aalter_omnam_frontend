"use client"

// Stage 3 of the HeyGen → LiveKit migration.
//
// Replaces components/liveavatar/SandboxLiveAvatar.tsx's
// SandboxSessionPlayer for the /home-v2 path. Renders the Hedra
// avatar's video track in whatever container the parent provides —
// styling-neutral by design.
//
// No chroma-key pass: Hedra's avatar output is already composited
// against a transparent/solid background by the agent side, unlike
// HeyGen's green-screen stream.
//
// DebugHud and useDebugLogger are re-exported from the legacy file
// because they only depend on useUserProfile() and useUserProfileContext()
// — both of which are provider-agnostic (useUserProfile lives in
// @/lib/livekit/useUserProfile and reads the LiveKit context). When
// imported into a /home-v2 page where the LiveKitAvatarContextProvider
// is in scope, the legacy DebugHud's `import { useUserProfile } from
// "@/lib/liveavatar"` *would* still work but would read from the
// HeyGen context instead. To avoid that cross-wiring, this file
// provides LiveKit-specific re-exports that import from @/lib/livekit
// directly.

import { useEffect, useRef } from "react"

import { useLiveKitAvatarContext, useSession, useUserProfile } from "@/lib/livekit"
import { useUserProfileContext } from "@/lib/context"
import { ChevronDown } from "lucide-react"
import { useState } from "react"

const AVATAR_PARTICIPANT_NAME = "hedra-avatar-agent"

type LiveKitAvatarPlayerProps = {
  fit?: "contain" | "cover"
}

export const LiveKitAvatarPlayer = ({
  fit = "contain",
}: LiveKitAvatarPlayerProps) => {
  const { sessionRef, isStreamReady } = useLiveKitAvatarContext()
  const { attachElement } = useSession()
  const videoRef = useRef<HTMLVideoElement>(null)

  // Re-attach whenever the stream becomes ready (participant joined
  // after mount) or when the video element re-mounts.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!isStreamReady) return
    attachElement(video)
    video.play().catch(() => undefined)
  }, [attachElement, isStreamReady])

  // On unmount, detach the track so livekit-client releases its
  // reference to the video element.
  useEffect(() => {
    return () => {
      const room = sessionRef.current
      const video = videoRef.current
      if (!room || !video) return
      for (const participant of room.remoteParticipants.values()) {
        if (participant.name !== AVATAR_PARTICIPANT_NAME) continue
        for (const publication of participant.videoTrackPublications.values()) {
          publication.track?.detach(video)
        }
      }
    }
  }, [sessionRef])

  return (
    <div className="w-full h-full relative">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
      />
    </div>
  )
}

// ---------------------------------------------------------------------
// DebugHud / useDebugLogger — LiveKit-scoped copies
// ---------------------------------------------------------------------
//
// These are functionally identical to the legacy ones in
// components/liveavatar/SandboxLiveAvatar.tsx, with the single
// difference that they import useUserProfile from @/lib/livekit
// instead of @/lib/liveavatar. Keeping a local copy (rather than
// re-exporting the legacy function) avoids a subtle cross-wiring bug
// where a component re-exported from legacy would close over the
// legacy useLiveAvatarContext binding even when rendered inside a
// LiveKitAvatarContextProvider — the hook would look up the wrong
// context and throw.

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
                    &quot;{m.message}&quot;
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
