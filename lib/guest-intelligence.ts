"use client"

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react"
import React from "react"

// ---------------------------------------------------------------------------
// GuestIntelligence — passively collected analytics data
// ---------------------------------------------------------------------------
// This data is NOT shown to the user. It is collected in the background
// during the conversation and can be serialized/sent to a backend API
// for hotel teams to use for personalization and revenue optimization.
// ---------------------------------------------------------------------------

export type Objection = {
  topic: string
  resolution: string
  resolved: boolean
}

export type ConsentFlags = {
  marketing: boolean
  dataSharing: boolean
  analytics: boolean
  thirdParty: boolean
}

export type BookingOutcome =
  | "in_progress"
  | "booked"
  | "abandoned"
  | "saved_for_later"
  | "requested_callback"

export type GuestIntelligence = {
  upsellReceptivity: number
  topQuestions: string[]
  objections: Objection[]
  bookingOutcome: BookingOutcome
  conversationDuration: number
  roomsExplored: string[]
  consentFlags: ConsentFlags
  referralSource?: string
  devicePlatform?: string
}

type GuestIntelligenceContextValue = {
  data: GuestIntelligence
  trackQuestion: (question: string) => void
  trackObjection: (objection: Objection) => void
  trackRoomExplored: (roomId: string) => void
  setUpsellReceptivity: (score: number) => void
  setBookingOutcome: (outcome: BookingOutcome) => void
  setConsentFlags: (flags: Partial<ConsentFlags>) => void
}

const DEFAULT_INTELLIGENCE: GuestIntelligence = {
  upsellReceptivity: 0.5,
  topQuestions: [],
  objections: [],
  bookingOutcome: "in_progress",
  conversationDuration: 0,
  roomsExplored: [],
  consentFlags: {
    marketing: false,
    dataSharing: false,
    analytics: false,
    thirdParty: false,
  },
}

const GuestIntelligenceContext = createContext<GuestIntelligenceContextValue | null>(null)

export function GuestIntelligenceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<GuestIntelligence>(DEFAULT_INTELLIGENCE)
  const startTimeRef = useRef(Date.now())

  const trackQuestion = useCallback((question: string) => {
    setData((prev) => ({
      ...prev,
      topQuestions: [...prev.topQuestions.filter((q) => q !== question), question].slice(-20),
    }))
  }, [])

  const trackObjection = useCallback((objection: Objection) => {
    setData((prev) => ({
      ...prev,
      objections: [...prev.objections, objection],
    }))
  }, [])

  const trackRoomExplored = useCallback((roomId: string) => {
    setData((prev) => ({
      ...prev,
      roomsExplored: prev.roomsExplored.includes(roomId)
        ? prev.roomsExplored
        : [...prev.roomsExplored, roomId],
    }))
  }, [])

  const setUpsellReceptivity = useCallback((score: number) => {
    setData((prev) => ({ ...prev, upsellReceptivity: Math.max(0, Math.min(1, score)) }))
  }, [])

  const setBookingOutcome = useCallback((outcome: BookingOutcome) => {
    setData((prev) => ({
      ...prev,
      bookingOutcome: outcome,
      conversationDuration: Math.round((Date.now() - startTimeRef.current) / 1000),
    }))
  }, [])

  const setConsentFlags = useCallback((flags: Partial<ConsentFlags>) => {
    setData((prev) => ({
      ...prev,
      consentFlags: { ...prev.consentFlags, ...flags },
    }))
  }, [])

  const value = useMemo(
    () => ({
      data,
      trackQuestion,
      trackObjection,
      trackRoomExplored,
      setUpsellReceptivity,
      setBookingOutcome,
      setConsentFlags,
    }),
    [data, trackQuestion, trackObjection, trackRoomExplored, setUpsellReceptivity, setBookingOutcome, setConsentFlags],
  )

  return React.createElement(
    GuestIntelligenceContext.Provider,
    { value },
    children,
  )
}

export function useGuestIntelligence() {
  const context = useContext(GuestIntelligenceContext)
  if (!context) {
    throw new Error("useGuestIntelligence must be used within a GuestIntelligenceProvider")
  }
  return context
}
