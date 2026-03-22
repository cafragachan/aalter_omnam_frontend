"use client"

import { useCallback, useRef, useState } from "react"
import { auth } from "@/lib/firebase"
import { useUserProfileContext } from "@/lib/context"
import { useGuestIntelligence } from "@/lib/guest-intelligence"
import { useUserProfile } from "@/lib/liveavatar"
import { useLiveAvatarContext } from "@/lib/liveavatar"
import { useApp } from "@/lib/store"
import { uploadSessionSnapshot, writeSessionPointer } from "./session-service"
import { persistSessionData } from "./user-profile-service"
import type { SessionSnapshot, SessionPointer, SerializedUserProfile } from "./types"
import type { UserProfile } from "@/lib/context"

// ---------------------------------------------------------------------------
// Serialize Date fields in UserProfile to ISO strings
// ---------------------------------------------------------------------------

function serializeProfile(profile: UserProfile): SerializedUserProfile {
  return {
    ...profile,
    startDate: profile.startDate instanceof Date ? profile.startDate.toISOString() : (profile.startDate ?? null),
    endDate: profile.endDate instanceof Date ? profile.endDate.toISOString() : (profile.endDate ?? null),
    dateOfBirth: profile.dateOfBirth instanceof Date ? profile.dateOfBirth.toISOString() : (profile.dateOfBirth ?? null),
  }
}

// ---------------------------------------------------------------------------
// useSessionPersistence — orchestrates saving session data to Firebase
// ---------------------------------------------------------------------------

export function useSessionPersistence() {
  const [sessionId] = useState(() => crypto.randomUUID())
  const sessionStartedAtRef = useRef(new Date().toISOString())
  const hasPersistedRef = useRef(false)

  const { profile, journeyStage } = useUserProfileContext()
  const guestIntelligence = useGuestIntelligence()
  const { userMessages } = useUserProfile()
  const { messages } = useLiveAvatarContext()
  const { selectedHotel } = useApp()

  const persistSession = useCallback(async () => {
    // Guard: only persist once per session
    if (hasPersistedRef.current) return
    hasPersistedRef.current = true

    const user = auth?.currentUser
    if (!user) {
      console.warn("[useSessionPersistence] No authenticated user — skipping persist")
      hasPersistedRef.current = false
      return
    }

    const userId = user.uid
    const now = new Date().toISOString()

    try {
      // Run AI analysis with 3s timeout
      const giSnapshot = guestIntelligence.getDataSnapshot()
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3000)
        const res = await fetch("/api/analyze-guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile,
            guestIntelligence: giSnapshot,
            conversationMessages: userMessages,
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (res.ok) {
          const analysis = await res.json()
          if (analysis.personalityTraits) giSnapshot.personalityTraits = analysis.personalityTraits
          if (analysis.travelDriver) giSnapshot.travelDriver = analysis.travelDriver
        }
      } catch {
        // Graceful degradation — persist without AI fields
      }

      // Build session snapshot
      const snapshot: SessionSnapshot = {
        sessionId,
        userId,
        startedAt: sessionStartedAtRef.current,
        endedAt: now,
        profile: serializeProfile(profile),
        guestIntelligence: giSnapshot,
        journeyStage,
        conversationMessages: messages.map((m) => ({
          sender: m.sender,
          message: m.message,
          timestamp: m.timestamp,
        })),
        hotel: selectedHotel,
      }

      const storagePath = `sessions/${userId}/${sessionId}.json`

      // Build session pointer
      const pointer: SessionPointer = {
        startedAt: sessionStartedAtRef.current,
        endedAt: now,
        hotel: selectedHotel,
        journeyStage,
        bookingOutcome: giSnapshot.bookingOutcome,
        storagePath,
      }

      // Persist everything in parallel
      await Promise.allSettled([
        uploadSessionSnapshot(userId, sessionId, snapshot),
        writeSessionPointer(userId, sessionId, pointer),
        persistSessionData(userId, snapshot),
      ])

      console.log("[useSessionPersistence] Session persisted:", sessionId)
    } catch (err) {
      console.error("[useSessionPersistence] Failed to persist session:", err)
      hasPersistedRef.current = false // Allow retry on failure
    }
  }, [sessionId, profile, journeyStage, guestIntelligence, userMessages, messages, selectedHotel])

  return { sessionId, persistSession }
}
