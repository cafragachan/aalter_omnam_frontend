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

export type RoomExploration = {
  roomId: string
  timeSpentMs: number
}

export type AmenityExploration = {
  name: string
  timeSpentMs: number
}

export type GuestIntelligence = {
  upsellReceptivity: number
  topQuestions: string[]
  objections: Objection[]
  bookingOutcome: BookingOutcome
  conversationDuration: number
  roomsExplored: RoomExploration[]
  amenitiesExplored: AmenityExploration[]
  consentFlags: ConsentFlags
  requirements: string[]
  referralSource?: string
  devicePlatform?: string
}

type GuestIntelligenceContextValue = {
  data: GuestIntelligence
  trackQuestion: (question: string) => void
  trackObjection: (objection: Objection) => void
  trackRoomExplored: (roomId: string) => void
  trackAmenityExplored: (name: string) => void
  startRoomTimer: (roomId: string) => void
  startAmenityTimer: (name: string) => void
  stopExplorationTimer: () => void
  trackRequirement: (requirement: string) => void
  getDataSnapshot: () => GuestIntelligence
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
  amenitiesExplored: [],
  requirements: [],
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
  const activeExplorationRef = useRef<{
    type: "room" | "amenity"
    id: string
    startedAt: number
  } | null>(null)

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
      roomsExplored: prev.roomsExplored.some((r) => r.roomId === roomId)
        ? prev.roomsExplored
        : [...prev.roomsExplored, { roomId, timeSpentMs: 0 }],
    }))
  }, [])

  const trackAmenityExplored = useCallback((name: string) => {
    setData((prev) => ({
      ...prev,
      amenitiesExplored: prev.amenitiesExplored.some((a) => a.name === name)
        ? prev.amenitiesExplored
        : [...prev.amenitiesExplored, { name, timeSpentMs: 0 }],
    }))
  }, [])

  const trackRequirement = useCallback((requirement: string) => {
    setData((prev) => ({
      ...prev,
      requirements: prev.requirements.includes(requirement)
        ? prev.requirements
        : [...prev.requirements, requirement],
    }))
  }, [])

  // --- Exploration timer API ---

  const stopExplorationTimer = useCallback(() => {
    const active = activeExplorationRef.current
    if (!active) return
    const elapsed = Date.now() - active.startedAt
    activeExplorationRef.current = null

    if (active.type === "room") {
      setData((prev) => ({
        ...prev,
        roomsExplored: prev.roomsExplored.map((r) =>
          r.roomId === active.id ? { ...r, timeSpentMs: r.timeSpentMs + elapsed } : r,
        ),
      }))
    } else {
      setData((prev) => ({
        ...prev,
        amenitiesExplored: prev.amenitiesExplored.map((a) =>
          a.name === active.id ? { ...a, timeSpentMs: a.timeSpentMs + elapsed } : a,
        ),
      }))
    }
  }, [])

  const startRoomTimer = useCallback((roomId: string) => {
    stopExplorationTimer()
    activeExplorationRef.current = { type: "room", id: roomId, startedAt: Date.now() }
  }, [stopExplorationTimer])

  const startAmenityTimer = useCallback((name: string) => {
    stopExplorationTimer()
    activeExplorationRef.current = { type: "amenity", id: name, startedAt: Date.now() }
  }, [stopExplorationTimer])

  const getDataSnapshot = useCallback((): GuestIntelligence => {
    const active = activeExplorationRef.current
    if (!active) return data

    const elapsed = Date.now() - active.startedAt
    if (active.type === "room") {
      return {
        ...data,
        roomsExplored: data.roomsExplored.map((r) =>
          r.roomId === active.id ? { ...r, timeSpentMs: r.timeSpentMs + elapsed } : r,
        ),
      }
    }
    return {
      ...data,
      amenitiesExplored: data.amenitiesExplored.map((a) =>
        a.name === active.id ? { ...a, timeSpentMs: a.timeSpentMs + elapsed } : a,
      ),
    }
  }, [data])

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
      trackAmenityExplored,
      trackRequirement,
      startRoomTimer,
      startAmenityTimer,
      stopExplorationTimer,
      getDataSnapshot,
      setUpsellReceptivity,
      setBookingOutcome,
      setConsentFlags,
    }),
    [data, trackQuestion, trackObjection, trackRoomExplored, trackAmenityExplored, trackRequirement, startRoomTimer, startAmenityTimer, stopExplorationTimer, getDataSnapshot, setUpsellReceptivity, setBookingOutcome, setConsentFlags],
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
