"use client"

import { useEffect, useRef, useState, type MouseEvent } from "react"
import { SandboxLiveAvatar, DebugHud } from "@/components/liveavatar/SandboxLiveAvatar"
import { useUserProfile } from "@/lib/liveavatar"
import { useUserProfileContext } from "@/lib/context"

const ProfileSync = () => {
  const { profile } = useUserProfile()
  const { updateProfile } = useUserProfileContext()

  useEffect(() => {
    if (
      !profile.name &&
      !profile.destination &&
      !profile.partySize &&
      profile.interests.length === 0
    ) {
      return
    }

    const [firstName, ...lastNameParts] = (profile.name ?? "").split(" ").filter(Boolean)
    updateProfile({
      firstName: firstName || undefined,
      lastName: lastNameParts.join(" ") || undefined,
      familySize: profile.partySize,
      destinationPreferences: profile.destination ? [profile.destination] : undefined,
      interests: profile.interests,
    })
  }, [profile.destination, profile.interests, profile.name, profile.partySize, updateProfile])

  return null
}

export default function HomePage() {
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamUrl = process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = streamUrl !== "about:blank"

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
                    </div>
                  }
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
