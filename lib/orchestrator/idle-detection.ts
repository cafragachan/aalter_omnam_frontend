"use client"

import { useCallback, useEffect, useRef } from "react"
import { useLiveAvatarContext as useHeyGenLiveAvatarContext } from "@/lib/liveavatar"
import type { JourneyStage } from "@/lib/context"

// ---------------------------------------------------------------------------
// Idle Detection — detects silence and triggers re-engagement
// ---------------------------------------------------------------------------
// Uses isAvatarTalking / isUserTalking state to detect when neither
// party is speaking. After a stage-specific threshold, fires onIdle()
// so the journey machine can produce a SPEAK effect.
//
// Stage 5: accepts an optional hooks parameter (same DI pattern as
// useJourney) so /home-v2 can supply the LiveKit context instead.
// ---------------------------------------------------------------------------

export type IdleDetectionHooks = {
  useContext: () => { isAvatarTalking: boolean; isUserTalking: boolean }
}

const IDLE_THRESHOLDS: Record<JourneyStage, number> = {
  PROFILE_COLLECTION: 12_000,
  DESTINATION_SELECT: 15_000,
  VIRTUAL_LOUNGE: 12_000,
  HOTEL_EXPLORATION: 18_000,
  END_EXPERIENCE: Infinity,
}

type UseIdleDetectionOptions = {
  journeyStage: JourneyStage
  onIdle: () => void
  enabled?: boolean
  hooks?: IdleDetectionHooks
}

export function useIdleDetection({ journeyStage, onIdle, enabled = true, hooks }: UseIdleDetectionOptions) {
  const useContextFn = hooks?.useContext ?? useHeyGenLiveAvatarContext
  const { isAvatarTalking, isUserTalking } = useContextFn()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onIdleRef = useRef(onIdle)
  onIdleRef.current = onIdle

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const resetTimer = useCallback(() => {
    clearTimer()
    if (!enabled) return

    const threshold = IDLE_THRESHOLDS[journeyStage] ?? 18_000

    timerRef.current = setTimeout(() => {
      onIdleRef.current()
    }, threshold)
  }, [clearTimer, enabled, journeyStage])

  // Reset timer whenever someone starts/stops talking
  useEffect(() => {
    if (isAvatarTalking || isUserTalking) {
      clearTimer()
    } else {
      resetTimer()
    }
  }, [isAvatarTalking, isUserTalking, clearTimer, resetTimer])

  // Reset timer when journey stage changes
  useEffect(() => {
    resetTimer()
  }, [journeyStage, resetTimer])

  // Cleanup on unmount
  useEffect(() => {
    return () => clearTimer()
  }, [clearTimer])

  return { resetTimer }
}
