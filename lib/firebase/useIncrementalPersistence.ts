"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { auth } from "@/lib/firebase"
import { useUserProfileContext } from "@/lib/context"
import { useGuestIntelligence } from "@/lib/guest-intelligence"
import { useUserProfile } from "@/lib/liveavatar"
import { useLiveAvatarContext } from "@/lib/liveavatar"
import { useApp } from "@/lib/store"
import { initSessionPointer, updateSessionPointerFields, uploadSessionSnapshot } from "./session-service"
import {
  mergePersonalityIncremental,
  mergePreferencesIncremental,
  incrementTotalSessions,
  incrementTotalBookings,
  updateConsent,
} from "./user-profile-service"
import type { SessionSnapshot } from "./types"
import type { UserProfile } from "@/lib/context"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUid(): string | null {
  return auth?.currentUser?.uid ?? null
}

function serializeProfile(profile: UserProfile) {
  return {
    ...profile,
    startDate: profile.startDate instanceof Date ? profile.startDate.toISOString() : (profile.startDate ?? null),
    endDate: profile.endDate instanceof Date ? profile.endDate.toISOString() : (profile.endDate ?? null),
    dateOfBirth: profile.dateOfBirth instanceof Date ? profile.dateOfBirth.toISOString() : (profile.dateOfBirth ?? null),
  }
}

// ---------------------------------------------------------------------------
// useIncrementalPersistence — writes session data to Firebase throughout
// the session instead of all-at-once at the end.
// ---------------------------------------------------------------------------

export function useIncrementalPersistence() {
  const [sessionId] = useState(() => crypto.randomUUID())
  const sessionStartedAtRef = useRef(new Date().toISOString())
  const sessionInitializedRef = useRef(false)
  const loyaltyIncrementedRef = useRef(false)
  const bookingTrackedRef = useRef(false)
  const profileDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastProfileKeyRef = useRef("")
  const lastConsentKeyRef = useRef("")
  const endOfSessionDoneRef = useRef(false)

  const { profile, journeyStage } = useUserProfileContext()
  const guestIntelligence = useGuestIntelligence()
  const { userMessages } = useUserProfile()
  const { messages } = useLiveAvatarContext()
  const { selectedHotel } = useApp()

  // =========================================================================
  // Shared: build a SessionSnapshot from current state
  // =========================================================================

  const buildSnapshot = useCallback(
    (uid: string, giOverride?: ReturnType<typeof guestIntelligence.getDataSnapshot>): SessionSnapshot => {
      const gi = giOverride ?? guestIntelligence.getDataSnapshot()
      return {
        sessionId,
        userId: uid,
        startedAt: sessionStartedAtRef.current,
        endedAt: new Date().toISOString(),
        profile: serializeProfile(profile),
        guestIntelligence: gi,
        journeyStage,
        conversationMessages: messages.map((m) => ({
          sender: m.sender,
          message: m.message,
          timestamp: m.timestamp,
        })),
        hotel: selectedHotel,
      }
    },
    [sessionId, profile, journeyStage, guestIntelligence, messages, selectedHotel],
  )

  // =========================================================================
  // Shared: upload snapshot to Storage (fire-and-forget, with logging)
  // =========================================================================

  const writeSnapshotToStorage = useCallback(
    (uid: string, giOverride?: ReturnType<typeof guestIntelligence.getDataSnapshot>) => {
      const snapshot = buildSnapshot(uid, giOverride)
      uploadSessionSnapshot(uid, sessionId, snapshot).catch((err) =>
        console.error("[incremental-persist] Failed to write snapshot to Storage:", err),
      )
    },
    [sessionId, buildSnapshot],
  )

  // =========================================================================
  // 1. Session start — create pointer + increment totalSessions (once)
  // =========================================================================

  useEffect(() => {
    if (sessionInitializedRef.current) return
    const uid = getUid()
    if (!uid) return
    sessionInitializedRef.current = true

    initSessionPointer(uid, sessionId, sessionStartedAtRef.current).catch((err) =>
      console.error("[incremental-persist] Failed to init session pointer:", err),
    )

    if (!loyaltyIncrementedRef.current) {
      loyaltyIncrementedRef.current = true
      incrementTotalSessions(uid).catch((err) =>
        console.error("[incremental-persist] Failed to increment sessions:", err),
      )
    }
  }, [sessionId])

  // =========================================================================
  // 2. Journey stage changes → update pointer + write snapshot to Storage
  // =========================================================================

  useEffect(() => {
    const uid = getUid()
    if (!uid || !sessionInitializedRef.current) return

    updateSessionPointerFields(uid, sessionId, {
      journeyStage,
      endedAt: new Date().toISOString(),
    }).catch((err) =>
      console.error("[incremental-persist] Failed to update journeyStage:", err),
    )

    // Write a milestone snapshot to Storage on every stage transition
    writeSnapshotToStorage(uid)
  }, [sessionId, journeyStage, writeSnapshotToStorage])

  // =========================================================================
  // 3. Hotel selection → update pointer + write snapshot to Storage
  // =========================================================================

  useEffect(() => {
    const uid = getUid()
    if (!uid || !sessionInitializedRef.current || !selectedHotel) return

    updateSessionPointerFields(uid, sessionId, {
      hotel: selectedHotel,
    }).catch((err) =>
      console.error("[incremental-persist] Failed to update hotel:", err),
    )

    // Milestone snapshot — hotel selection is a key moment
    writeSnapshotToStorage(uid)
  }, [sessionId, selectedHotel, writeSnapshotToStorage])

  // =========================================================================
  // 4. Profile changes → debounced merge to personality + preferences (3s)
  // =========================================================================

  useEffect(() => {
    const profileKey = JSON.stringify({
      interests: profile.interests,
      travelPurpose: profile.travelPurpose,
      budgetRange: profile.budgetRange,
      destination: profile.destination,
      guestComposition: profile.guestComposition,
      dietaryRestrictions: profile.dietaryRestrictions,
      accessibilityNeeds: profile.accessibilityNeeds,
      amenityPriorities: profile.amenityPriorities,
    })

    if (profileKey === lastProfileKeyRef.current) return
    lastProfileKeyRef.current = profileKey

    if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
    profileDebounceRef.current = setTimeout(() => {
      const uid = getUid()
      if (!uid) return
      const gi = guestIntelligence.getDataSnapshot()

      Promise.allSettled([
        mergePersonalityIncremental(uid, profile, gi),
        mergePreferencesIncremental(uid, profile, gi),
      ]).catch((err) =>
        console.error("[incremental-persist] Failed to merge profile:", err),
      )
    }, 3000)

    return () => {
      if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
    }
  }, [profile, guestIntelligence])

  // =========================================================================
  // 5. Consent flags → write immediately (legal requirement)
  // =========================================================================

  useEffect(() => {
    const flags = guestIntelligence.data.consentFlags
    const consentKey = JSON.stringify(flags)
    if (consentKey === lastConsentKeyRef.current) return
    lastConsentKeyRef.current = consentKey

    const uid = getUid()
    if (!uid) return

    updateConsent(uid, flags).catch((err) =>
      console.error("[incremental-persist] Failed to update consent:", err),
    )
  }, [guestIntelligence.data.consentFlags])

  // =========================================================================
  // 6. Booking outcome → update pointer + increment bookings if "booked"
  // =========================================================================

  useEffect(() => {
    const outcome = guestIntelligence.data.bookingOutcome
    if (outcome === "in_progress") return

    const uid = getUid()
    if (!uid || !sessionInitializedRef.current) return

    updateSessionPointerFields(uid, sessionId, {
      bookingOutcome: outcome,
    }).catch((err) =>
      console.error("[incremental-persist] Failed to update bookingOutcome:", err),
    )

    if (outcome === "booked" && !bookingTrackedRef.current) {
      bookingTrackedRef.current = true
      incrementTotalBookings(uid).catch((err) =>
        console.error("[incremental-persist] Failed to increment bookings:", err),
      )
    }

    // Milestone snapshot — booking outcome change is significant
    writeSnapshotToStorage(uid)
  }, [sessionId, guestIntelligence.data.bookingOutcome, writeSnapshotToStorage])

  // =========================================================================
  // 7. End-of-session snapshot (final flush with AI analysis)
  // =========================================================================

  const writeEndOfSessionSnapshot = useCallback(async () => {
    if (endOfSessionDoneRef.current) return
    endOfSessionDoneRef.current = true

    const uid = getUid()
    if (!uid) {
      endOfSessionDoneRef.current = false
      return
    }

    try {
      // Flush any pending debounced profile write
      if (profileDebounceRef.current) {
        clearTimeout(profileDebounceRef.current)
        profileDebounceRef.current = null
        const gi = guestIntelligence.getDataSnapshot()
        await Promise.allSettled([
          mergePersonalityIncremental(uid, profile, gi),
          mergePreferencesIncremental(uid, profile, gi),
        ])
      }

      const giSnapshot = guestIntelligence.getDataSnapshot()

      // Run AI analysis with 3s timeout (nice-to-have enrichment)
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
        // Graceful degradation
      }

      // Write final personality merge with AI-enriched data
      await Promise.allSettled([
        mergePersonalityIncremental(uid, profile, giSnapshot),
        mergePreferencesIncremental(uid, profile, giSnapshot),
      ])

      const now = new Date().toISOString()

      // Update session pointer endedAt
      await updateSessionPointerFields(uid, sessionId, { endedAt: now }).catch(() => {})

      // Upload final snapshot to Storage (overwrites milestone snapshots)
      const snapshot = buildSnapshot(uid, giSnapshot)
      await uploadSessionSnapshot(uid, sessionId, snapshot)

      console.log("[incremental-persist] End-of-session snapshot written:", sessionId)
    } catch (err) {
      console.error("[incremental-persist] Failed end-of-session snapshot:", err)
      endOfSessionDoneRef.current = false
    }
  }, [sessionId, profile, journeyStage, guestIntelligence, userMessages, messages, selectedHotel, buildSnapshot])

  // =========================================================================
  // 8. Visibility change — flush pending writes + snapshot to Storage
  // =========================================================================

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return
      const uid = getUid()
      if (!uid || !sessionInitializedRef.current) return

      // Flush pending profile debounce
      if (profileDebounceRef.current) {
        clearTimeout(profileDebounceRef.current)
        profileDebounceRef.current = null
        const gi = guestIntelligence.getDataSnapshot()
        // Fire-and-forget — browser may kill these, but data is mostly persisted
        mergePersonalityIncremental(uid, profile, gi).catch(() => {})
        mergePreferencesIncremental(uid, profile, gi).catch(() => {})
      }

      // Update endedAt (small write, most likely to succeed)
      updateSessionPointerFields(uid, sessionId, {
        endedAt: new Date().toISOString(),
      }).catch(() => {})

      // Attempt a snapshot write (may or may not complete before browser kills page)
      writeSnapshotToStorage(uid)
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange)
  }, [sessionId, profile, guestIntelligence, writeSnapshotToStorage])

  return { sessionId, writeEndOfSessionSnapshot }
}
