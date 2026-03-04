"use client"

import { useCallback, useEffect, useRef } from "react"
import { useUserProfileContext } from "@/lib/context"
import { useUserProfile } from "@/lib/liveavatar"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useEventBus, useEventListener } from "@/lib/events"
import { useGuestIntelligence } from "@/lib/guest-intelligence"
import { classifyIntent } from "./intents"
import { journeyReducer, INITIAL_JOURNEY_STATE, buildAmenityNarrative } from "./journey-machine"
import { useIdleDetection } from "./idle-detection"
import type { JourneyState, JourneyAction, JourneyEffect } from "./types"
import type { Amenity, Room } from "@/lib/hotel-data"

// ---------------------------------------------------------------------------
// useJourney — wires the pure state machine to React
// ---------------------------------------------------------------------------

type UseJourneyOptions = {
  onOpenPanel: (panel: "rooms" | "amenities" | "location") => void
  onClosePanels: () => void
  onUE5Command: (command: string, value: unknown) => void
  onResetToDefault: () => void
  onFadeTransition: () => void
  onUnitSelected?: (roomName: string) => void
  /** Amenities for the currently selected hotel (needed for voice-driven navigation) */
  amenities: Amenity[]
  /** Rooms for the currently selected hotel (needed for booking URL resolution) */
  rooms: Room[]
}

export function useJourney(options: UseJourneyOptions) {
  const {
    onOpenPanel,
    onClosePanels,
    onUE5Command,
    onResetToDefault,
    onFadeTransition,
    amenities,
    rooms,
  } = options

  const { profile, journeyStage, setJourneyStage } = useUserProfileContext()
  const { profile: derivedProfile, isExtractionPending, userMessages } = useUserProfile()
  const { repeat, interrupt } = useAvatarActions("FULL")
  const eventBus = useEventBus()
  const guestIntelligence = useGuestIntelligence()
  const { trackQuestion, trackRoomExplored, trackAmenityExplored, trackRequirement, startRoomTimer, startAmenityTimer, stopExplorationTimer, setBookingOutcome } = guestIntelligence

  // --- State machine state (kept in ref to avoid re-render cascades) ---
  const stateRef = useRef<JourneyState>(INITIAL_JOURNEY_STATE)
  const lastMessageCountRef = useRef(0)
  const lastProfileKeyRef = useRef("")
  const destinationAnnouncedRef = useRef(false)
  const profileDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentRoomIdRef = useRef<string | null>(null)

  // --- Admin: download all collected user data as JSON ---
  const downloadUserData = useCallback(() => {
    const payload = {
      timestamp: new Date().toISOString(),
      profile,
      derivedProfile,
      guestIntelligence: guestIntelligence.getDataSnapshot(),
      journeyStage,
      conversationMessages: userMessages,
    }

    const json = JSON.stringify(payload, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `omnam-guest-data-${profile.firstName ?? "guest"}-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [profile, derivedProfile, guestIntelligence, journeyStage, userMessages])

  // --- Voice-driven amenity navigation ---
  const navigateToAmenityByName = useCallback((amenityName: string) => {
    const match = amenities.find((a) => {
      const n = a.name.toLowerCase()
      const s = a.scene.toLowerCase()
      return n.includes(amenityName) || s.includes(amenityName)
    })

    if (!match) {
      interrupt()
      repeat(`I don't think we have a ${amenityName} at this property. Would you like to see the rooms, or explore the surrounding area?`).catch(() => undefined)
      return
    }

    // Track this amenity visit + start timer
    trackAmenityExplored(match.name)
    startAmenityTimer(match.name)

    // Navigate UE5 + fade + speak narrative
    const narrative = buildAmenityNarrative(match.name, match.scene)
    onClosePanels()
    onUE5Command("communal", match.id)
    onFadeTransition()
    interrupt()
    repeat(`Let me take you to the ${match.name} — ${narrative}`).catch(() => undefined)

    // Update state to AMENITY_VIEWING
    stateRef.current = { stage: "AMENITY_VIEWING" }
  }, [amenities, trackAmenityExplored, onClosePanels, onUE5Command, onFadeTransition, interrupt, repeat])

  const listAmenities = useCallback(() => {
    if (amenities.length === 0) {
      interrupt()
      repeat("This property doesn't have any specific amenity spaces to tour right now. Shall we look at the rooms instead?").catch(() => undefined)
      return
    }

    const names = amenities.map((a) => a.name)
    const listText = names.length === 1
      ? `a ${names[0].toLowerCase()}`
      : names.slice(0, -1).map((n) => `a ${n.toLowerCase()}`).join(", ") + ` and a ${names[names.length - 1].toLowerCase()}`

    interrupt()
    repeat(`This property has ${listText}. Which would you like to visit?`).catch(() => undefined)
  }, [amenities, interrupt, repeat])

  // --- Effect executor ---
  const executeEffects = useCallback((effects: JourneyEffect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case "SPEAK":
          interrupt()
          repeat(effect.text).catch(() => undefined)
          break
        case "UE5_COMMAND":
          onUE5Command(effect.command, effect.value)
          break
        case "OPEN_PANEL":
          onOpenPanel(effect.panel)
          break
        case "CLOSE_PANELS":
          onClosePanels()
          break
        case "FADE_TRANSITION":
          onFadeTransition()
          break
        case "SET_JOURNEY_STAGE":
          setJourneyStage(effect.stage)
          break
        case "RESET_TO_DEFAULT":
          onResetToDefault()
          break
        case "DOWNLOAD_DATA":
          downloadUserData()
          break
        case "OPEN_BOOKING_URL": {
          const roomId = currentRoomIdRef.current
          if (roomId) {
            const room = rooms.find((r) => r.id === roomId)
            if (room?.book_url) {
              window.open(room.book_url, "_blank", "noopener,noreferrer")
              setBookingOutcome("booked")
            }
          }
          break
        }
      }
    }
  }, [interrupt, repeat, onUE5Command, onOpenPanel, onClosePanels, onFadeTransition, setJourneyStage, onResetToDefault, downloadUserData, rooms, setBookingOutcome])

  // --- Dispatch helper ---
  const dispatch = useCallback((action: JourneyAction) => {
    const result = journeyReducer(stateRef.current, action)
    stateRef.current = result.nextState
    if (result.effects.length > 0) {
      executeEffects(result.effects)
    }
  }, [executeEffects])

  // --- Idle detection (re-engagement) ---
  const handleIdle = useCallback(() => {
    dispatch({ type: "IDLE_TIMEOUT" })
  }, [dispatch])

  useIdleDetection({
    journeyStage,
    onIdle: handleIdle,
  })

  // --- React to profile changes ---
  useEffect(() => {
    const profileKey = JSON.stringify({
      partySize: derivedProfile.partySize,
      startDate: derivedProfile.startDate?.toISOString(),
      endDate: derivedProfile.endDate?.toISOString(),
      interests: derivedProfile.interests,
      travelPurpose: derivedProfile.travelPurpose,
      pending: isExtractionPending,
    })

    if (profileKey === lastProfileKeyRef.current) return
    lastProfileKeyRef.current = profileKey

    const doDispatch = () => {
      dispatch({
        type: "PROFILE_UPDATED",
        profile: derivedProfile,
        firstName: profile.firstName,
        isExtractionPending,
      })
    }

    // Debounce during PROFILE_COLLECTION so compound answers from
    // HeyGen's VAD splitting settle before evaluating profile completeness
    if (stateRef.current.stage === "PROFILE_COLLECTION") {
      if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
      profileDebounceRef.current = setTimeout(doDispatch, 2500)
      return () => {
        if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
      }
    }

    doDispatch()
  }, [derivedProfile, isExtractionPending, profile.firstName, dispatch])

  // --- React to new user messages (intent classification + question tracking) ---
  useEffect(() => {
    if (userMessages.length <= lastMessageCountRef.current) return
    lastMessageCountRef.current = userMessages.length

    const latestMessage = userMessages[userMessages.length - 1]?.message ?? ""

    // Track questions for GuestIntelligence
    if (latestMessage.includes("?")) {
      trackQuestion(latestMessage.trim())
    }

    // Track requirements for GuestIntelligence (runs at any stage)
    const REQUIREMENT_PATTERNS = [
      /\b(?:i need|i'd like|i would like|could you arrange|please arrange)\s+(.+?)(?:[.,!?]|$)/i,
      /\b(late\s+check.?out|early\s+check.?in)\b/i,
      /\b(allerg(?:y|ic)\s+to\s+.+?)(?:[.,!?]|$)/i,
      /\b(champagne|flowers|cake|surprise|celebration|anniversary|birthday)\b/i,
      /\b(crib|cot|baby\s+bed|extra\s+bed|rollaway|connecting\s+room|adjoining)\b/i,
      /\b(airport\s+transfer|airport\s+pickup|car\s+service)\b/i,
      /\b(feather.?free|hypoallergenic|firm\s+(?:mattress|pillow)|non.?smoking)\b/i,
      /\b(quiet\s+room|high(?:er)?\s+floor|away\s+from\s+(?:elevator|lift))\b/i,
    ]
    for (const pattern of REQUIREMENT_PATTERNS) {
      const match = latestMessage.match(pattern)
      if (match) {
        const requirement = (match[1] ?? match[0]).trim()
        if (requirement.length > 3 && requirement.length < 200) {
          trackRequirement(requirement)
        }
        break
      }
    }

    // Only classify intent when we're in a stage that cares about voice input
    const stage = stateRef.current.stage
    if (stage === "PROFILE_COLLECTION" || stage === "DESTINATION_SELECT") return

    const intent = classifyIntent(latestMessage)

    // --- Exploration timer management ---
    // Start room timer when user begins interior/exterior exploration
    if (stage === "ROOM_SELECTED" && (intent.type === "INTERIOR" || intent.type === "EXTERIOR")) {
      if (currentRoomIdRef.current) {
        startRoomTimer(currentRoomIdRef.current)
      }
    }

    // Stop exploration timer when leaving room/amenity context
    if (
      (stage === "ROOM_SELECTED" || stage === "AMENITY_VIEWING") &&
      (intent.type === "BACK" || intent.type === "ROOMS" || intent.type === "LOCATION" || intent.type === "HOTEL_EXPLORE")
    ) {
      stopExplorationTimer()
    }

    // --- Intercept amenity intents (need hotel data, not available in pure reducer) ---
    if (intent.type === "AMENITIES") {
      stopExplorationTimer()
      listAmenities()
      // Still dispatch to reducer so it updates state (it returns empty effects)
      dispatch({ type: "USER_INTENT", intent })
      return
    }

    if (intent.type === "AMENITY_BY_NAME") {
      navigateToAmenityByName(intent.amenityName)
      // Dispatch to reducer for state tracking
      dispatch({ type: "USER_INTENT", intent })
      return
    }

    dispatch({ type: "USER_INTENT", intent })
  }, [userMessages, dispatch, trackQuestion, trackRequirement, listAmenities, navigateToAmenityByName, startRoomTimer, stopExplorationTimer])

  // --- Announce destination overlay when stage transitions ---
  useEffect(() => {
    if (journeyStage !== "DESTINATION_SELECT") {
      destinationAnnouncedRef.current = false
      return
    }
    if (destinationAnnouncedRef.current) return
    destinationAnnouncedRef.current = true

    const timer = setTimeout(() => {
      interrupt()
      repeat(
        "Based on what you've told me, I think you'll love these options. Take a look — tap any card to step inside the digital twin.",
      ).catch(() => undefined)
    }, 500)
    return () => clearTimeout(timer)
  }, [journeyStage, interrupt, repeat])

  // --- EventBus subscriptions ---

  useEventListener("HOTEL_SELECTED", (event) => {
    dispatch({
      type: "HOTEL_PICKED",
      slug: event.slug,
      hotelName: "",
      location: "",
      description: "",
    })
  })

  useEventListener("ROOM_CARD_TAPPED", (event) => {
    stopExplorationTimer()
    trackRoomExplored(event.roomId)
    currentRoomIdRef.current = event.roomId
    dispatch({
      type: "ROOM_CARD_TAPPED",
      roomName: event.roomName,
      occupancy: event.occupancy,
      roomId: event.roomId,
    })
  })

  useEventListener("UNIT_SELECTED_UE5", (event) => {
    dispatch({
      type: "UNIT_SELECTED_UE5",
      roomName: event.roomName,
    })
    options.onUnitSelected?.(event.roomName)
  })

  useEventListener("AMENITY_CARD_TAPPED", (event) => {
    stopExplorationTimer()
    trackAmenityExplored(event.name)
    startAmenityTimer(event.name)
    dispatch({
      type: "AMENITY_CARD_TAPPED",
      name: event.name,
      scene: event.scene,
      amenityId: event.amenityId,
    })
  })

  useEventListener("NAVIGATE_BACK", () => {
    stopExplorationTimer()
    dispatch({ type: "USER_INTENT", intent: { type: "BACK" } })
  })

  return { dispatch }
}
