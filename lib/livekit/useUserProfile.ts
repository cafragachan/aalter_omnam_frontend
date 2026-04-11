"use client"

// Stage 3 of the HeyGen → LiveKit migration.
//
// Thin fork of lib/liveavatar/useUserProfile.ts. The profile-extraction
// logic is provider-agnostic — it only needs `messages` sourced from
// a LiveAvatar-shaped context. This fork imports the pure regex
// extractor from the legacy file (Stage 3 added an `export` keyword to
// extractWithRegex — the only edit to a legacy file in this stage) and
// wires up the AI extraction + merging exactly as the legacy hook does.
//
// Keeping the React hook wrapper in its own file lets the LiveKit path
// call useLiveKitAvatarContext() instead of useLiveAvatarContext() with
// zero runtime coupling between the two contexts.
//
// The AvatarDerivedProfile type is re-exported so /home-v2 consumers
// only need to import from @/lib/livekit.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  extractWithRegex,
  type AvatarDerivedProfile,
} from "@/lib/liveavatar/useUserProfile"
import { MessageSender } from "@/lib/liveavatar/types"

import { useLiveKitAvatarContext } from "./context"

export type { AvatarDerivedProfile }

type AIExtractedProfile = {
  name?: string | null
  partySize?: number | null
  destination?: string | null
  startDate?: string | null
  endDate?: string | null
  interests?: string[]
  travelPurpose?: string | null
  budgetRange?: string | null
  roomTypePreference?: string | null
  dietaryRestrictions?: string[]
  accessibilityNeeds?: string[]
  amenityPriorities?: string[]
  nationality?: string | null
  arrivalTime?: string | null
  guestComposition?: {
    adults: number
    children: number
    childrenAges?: number[]
  } | null
  distributionPreference?: "together" | "separate" | "auto" | null
  roomAllocation?: number[] | null
}

export const useUserProfile = (): {
  profile: AvatarDerivedProfile
  userMessages: { message: string; timestamp: number }[]
  triggerAIExtraction: () => Promise<void>
  isExtracting: boolean
  isExtractionPending: boolean
  aiAvailable: boolean
} => {
  const { messages } = useLiveKitAvatarContext()
  const [aiProfile, setAiProfile] = useState<AIExtractedProfile | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [aiAvailable, setAiAvailable] = useState(true)
  const lastExtractedCount = useRef(0)

  const userMessages = useMemo(
    () =>
      messages
        .filter((m) => m.sender === MessageSender.USER)
        .map(({ message, timestamp }) => ({ message, timestamp })),
    [messages],
  )

  const regexProfile = useMemo(() => extractWithRegex(userMessages), [userMessages])

  const profile = useMemo((): AvatarDerivedProfile => {
    if (!aiProfile) return regexProfile

    const mergedInterests = new Set([
      ...regexProfile.interests,
      ...(aiProfile.interests ?? []),
    ])
    const mergedDietary = new Set([
      ...(regexProfile.dietaryRestrictions ?? []),
      ...(aiProfile.dietaryRestrictions ?? []),
    ])
    const mergedAccessibility = new Set([
      ...(regexProfile.accessibilityNeeds ?? []),
      ...(aiProfile.accessibilityNeeds ?? []),
    ])

    return {
      name: aiProfile.name ?? regexProfile.name,
      partySize: aiProfile.partySize ?? regexProfile.partySize,
      destination: aiProfile.destination ?? regexProfile.destination,
      startDate: aiProfile.startDate
        ? new Date(aiProfile.startDate)
        : regexProfile.startDate,
      endDate: aiProfile.endDate
        ? new Date(aiProfile.endDate)
        : regexProfile.endDate,
      interests: Array.from(mergedInterests),
      travelPurpose: aiProfile.travelPurpose ?? regexProfile.travelPurpose,
      budgetRange: aiProfile.budgetRange ?? regexProfile.budgetRange,
      roomTypePreference:
        aiProfile.roomTypePreference ?? regexProfile.roomTypePreference,
      dietaryRestrictions:
        mergedDietary.size > 0 ? Array.from(mergedDietary) : undefined,
      accessibilityNeeds:
        mergedAccessibility.size > 0 ? Array.from(mergedAccessibility) : undefined,
      amenityPriorities:
        aiProfile.amenityPriorities ?? regexProfile.amenityPriorities,
      nationality: aiProfile.nationality ?? regexProfile.nationality,
      arrivalTime: aiProfile.arrivalTime ?? regexProfile.arrivalTime,
      guestComposition:
        aiProfile.guestComposition ?? regexProfile.guestComposition,
      distributionPreference:
        aiProfile.distributionPreference ?? regexProfile.distributionPreference,
      roomAllocation: aiProfile.roomAllocation ?? regexProfile.roomAllocation,
    }
  }, [regexProfile, aiProfile])

  const triggerAIExtraction = useCallback(async () => {
    if (!aiAvailable) return
    if (userMessages.length === 0 || isExtracting) return
    if (userMessages.length === lastExtractedCount.current) return

    setIsExtracting(true)
    try {
      const response = await fetch("/api/extract-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterances: userMessages.map((m) => m.message),
          currentProfile: regexProfile,
        }),
      })

      if (response.status === 501) {
        console.info("AI extraction not configured, using regex-only extraction")
        lastExtractedCount.current = userMessages.length
        setAiAvailable(false)
        return
      }

      if (response.ok) {
        const data = await response.json()
        if (data.profile) {
          setAiProfile(data.profile)
          lastExtractedCount.current = userMessages.length
        }
      } else {
        console.warn("AI extraction returned error:", response.status)
      }
    } catch (error) {
      console.error("AI extraction failed:", error)
    } finally {
      lastExtractedCount.current = userMessages.length
      setIsExtracting(false)
    }
  }, [userMessages, regexProfile, isExtracting, aiAvailable])

  useEffect(() => {
    if (userMessages.length === 0) return
    if (userMessages.length === lastExtractedCount.current) return

    if (!aiAvailable) {
      lastExtractedCount.current = userMessages.length
      return
    }

    const timer = setTimeout(() => {
      triggerAIExtraction()
    }, 2000)

    return () => clearTimeout(timer)
  }, [userMessages.length, triggerAIExtraction, aiAvailable])

  const isExtractionPending =
    aiAvailable &&
    (isExtracting || userMessages.length > lastExtractedCount.current)

  return {
    profile,
    userMessages,
    triggerAIExtraction,
    isExtracting,
    isExtractionPending,
    aiAvailable,
  }
}
