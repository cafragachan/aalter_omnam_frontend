"use client"

import { useCallback, useEffect, useRef } from "react"
import { useUserProfileContext } from "@/lib/context"
import { useUserProfile as useHeyGenUserProfile } from "@/lib/liveavatar"
import { useAvatarActions as useHeyGenAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useLiveAvatarContext as useHeyGenLiveAvatarContext } from "@/lib/liveavatar/context"
import { MessageSender } from "@/lib/liveavatar/types"
import type { LiveAvatarSessionMessage } from "@/lib/liveavatar/types"
import type { AvatarDerivedProfile } from "@/lib/liveavatar/useUserProfile"
import { useEventBus, useEventListener } from "@/lib/events"
import { useGuestIntelligence } from "@/lib/guest-intelligence"
import { classifyIntent, classifyAvatarProposal } from "./intents"
import { journeyReducer, INITIAL_JOURNEY_STATE, buildAmenityNarrative } from "./journey-machine"
import { useIdleDetection } from "./idle-detection"
import { buildProfileNudge } from "./profile-nudge"
import type { JourneyState, JourneyAction, JourneyEffect, AmenityRef } from "./types"
import {
  getRecommendedAmenity,
  getRecommendedRoomPlan,
  getBudgetRoomPlan,
  getCompactRoomPlan,
  buildExplicitRoomPlan,
  parseExplicitRoomRequests,
  matchRoomByName,
  type Amenity,
  type Room,
  type RoomPlan,
} from "@/lib/hotel-data"

// ---------------------------------------------------------------------------
// useJourney — wires the pure state machine to React
// ---------------------------------------------------------------------------

/**
 * Shape of the avatar-backend hooks useJourney depends on. Structural
 * subset shared by the legacy `@/lib/liveavatar` hooks and the new
 * `@/lib/livekit` hooks (Stage 3 mirrored the shape byte-for-byte).
 */
export type UseJourneyAvatarHooks = {
  useContext: () => { messages: LiveAvatarSessionMessage[]; isAvatarTalking: boolean; isUserTalking: boolean }
  useActions: () => {
    interrupt: () => unknown
    repeat: (text: string) => Promise<unknown>
    startListening: () => unknown
    stopListening: () => unknown
    message: (text: string) => void
  }
  useProfile: () => {
    profile: AvatarDerivedProfile
    userMessages: { message: string; timestamp: number }[]
    triggerAIExtraction: () => Promise<void>
    isExtracting: boolean
    isExtractionPending: boolean
    aiAvailable: boolean
  }
}

type UseJourneyOptions = {
  onOpenPanel: (panel: "rooms" | "amenities" | "location") => void
  onClosePanels: () => void
  onUE5Command: (command: string, value: unknown) => void
  onResetToDefault: () => void
  onFadeTransition: () => void
  onSelectHotel: (slug: string) => void
  onUnitSelected?: (roomName: string) => void
  /** Callback to update the displayed room plan (dynamic adjustments) */
  onUpdateRoomPlan?: (plan: RoomPlan) => void
  /** Callback to stop the HeyGen avatar session */
  onStopAvatar: () => void
  /** Callback to hide the UE5 stream iframe */
  onHideUE5Stream: () => void
  /** Amenities for the currently selected hotel (needed for voice-driven navigation) */
  amenities: Amenity[]
  /** Rooms for the currently selected hotel (needed for booking URL resolution) */
  rooms: Room[]
  /**
   * Stage 5 (LiveKit path): when provided, SPEAK effects are routed
   * through this callback instead of interrupt()+repeat() on the avatar
   * session. Legacy /home does not pass this — default behavior is
   * preserved exactly. /home-v2 passes a function that forwards the
   * text as a `narration_nudge` on the LiveKit data channel.
   */
  onSpeak?: (text: string) => void
  /**
   * Stage 5 (LiveKit path): pluggable avatar-backend hooks. When
   * omitted, defaults to `@/lib/liveavatar` (HeyGen) — legacy /home's
   * behavior is byte-for-byte unchanged. /home-v2 passes the matching
   * `@/lib/livekit` hooks so the same reducer runs against the LiveKit
   * data flow (messages, repeat/interrupt, profile extraction) without
   * touching useJourney's imports.
   *
   * This is the seam that lets a single shared orchestrator power both
   * avatar paths. It is mandatory — not just optional — for /home-v2,
   * because the default HeyGen hooks throw when called without a
   * LiveAvatarContextProvider mounted.
   */
  avatarHooks?: UseJourneyAvatarHooks
}

export function useJourney(options: UseJourneyOptions) {
  const {
    onOpenPanel,
    onClosePanels,
    onUE5Command,
    onResetToDefault,
    onFadeTransition,
    onSelectHotel,
    amenities,
    rooms,
  } = options

  // Resolve avatar-backend hooks. Default: legacy HeyGen hooks. /home-v2
  // passes the `@/lib/livekit` equivalents via options.avatarHooks. The
  // resolved functions are stable across renders because options.avatarHooks
  // is fixed for the component's lifetime, so Rules of Hooks is satisfied.
  const useAvatarContextFn = options.avatarHooks?.useContext ?? useHeyGenLiveAvatarContext
  const useUserProfileFn = options.avatarHooks?.useProfile ?? useHeyGenUserProfile
  const useAvatarActionsFn = options.avatarHooks?.useActions ?? (() => useHeyGenAvatarActions("FULL"))

  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const { profile: derivedProfile, isExtractionPending, userMessages } = useUserProfileFn()
  const { messages: allMessages } = useAvatarContextFn()
  const { repeat, interrupt, stopListening, message } = useAvatarActionsFn()
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
  const lastAvatarMessageCountRef = useRef(0)

  // --- Profile nudge tracking ---
  const nudgeAwaitingRef = useRef<string | null>(null)
  const nudgeCountRef = useRef(0)
  const nudgeLastSentRef = useRef(0)
  const avatarMsgsSinceProfileChangeRef = useRef(0)

  // --- Admin: download all collected user data as JSON ---
  const downloadUserData = useCallback(async () => {
    const giSnapshot = guestIntelligence.getDataSnapshot()

    // Run AI analysis to infer personality traits + travel driver
    try {
      const res = await fetch("/api/analyze-guest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          guestIntelligence: giSnapshot,
          conversationMessages: userMessages,
        }),
      })
      if (res.ok) {
        const analysis = await res.json()
        if (analysis.personalityTraits) giSnapshot.personalityTraits = analysis.personalityTraits
        if (analysis.travelDriver) giSnapshot.travelDriver = analysis.travelDriver
      }
    } catch {
      // Graceful degradation — download without AI fields
    }

    const payload = {
      timestamp: new Date().toISOString(),
      profile,
      derivedProfile,
      guestIntelligence: giSnapshot,
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

  // --- Effect executor ---
  const executeEffects = useCallback((effects: JourneyEffect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case "SPEAK":
          if (options.onSpeak) {
            options.onSpeak(effect.text)
          } else {
            interrupt()
            repeat(effect.text).catch(() => undefined)
          }
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
          onUE5Command("downloadData", "downloadData")
          break
        case "SELECT_HOTEL":
          onSelectHotel(effect.slug)
          break
        case "STOP_LISTENING":
          stopListening()
          break
        case "SET_ROOM_ALLOCATION":
          updateProfile({ roomAllocation: effect.allocation })
          break
        case "UPDATE_ROOM_PLAN":
          options.onUpdateRoomPlan?.(effect.plan)
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
        case "STOP_AVATAR":
          // Delay to let the farewell speech finish before stopping the session
          setTimeout(() => options.onStopAvatar(), 4000)
          break
        case "HIDE_UE5_STREAM":
          options.onHideUE5Stream()
          break
      }
    }
  }, [interrupt, repeat, stopListening, onUE5Command, onOpenPanel, onClosePanels, onFadeTransition, setJourneyStage, onResetToDefault, onSelectHotel, downloadUserData, rooms, setBookingOutcome, options])

  // --- Dispatch helper ---
  const dispatch = useCallback((action: JourneyAction) => {
    const result = journeyReducer(stateRef.current, action)
    stateRef.current = result.nextState
    if (result.effects.length > 0) {
      executeEffects(result.effects)
    }
  }, [executeEffects])

  // Expose the current internal JourneyState so outside observers
  // (e.g., useStateSyncBridge) can read the fine-grained substate.
  // Used by the state sync bridge to include `awaiting` in
  // state_snapshot payloads. Read-only for consumers.
  const getInternalState = useCallback(() => stateRef.current, [])

  // --- Amenity data helpers (compute data for rich actions dispatched to reducer) ---

  /** Build the lightweight AmenityRef[] the reducer needs from the full Amenity[] */
  const amenityRefs: AmenityRef[] = amenities.map((a) => ({ id: a.id, name: a.name, scene: a.scene }))

  /** Get visited amenity names from GuestIntelligence */
  const getVisitedAmenityNames = useCallback(
    () => guestIntelligence.data.amenitiesExplored.map((a) => a.name),
    [guestIntelligence.data.amenitiesExplored],
  )

  // --- Voice-driven amenity navigation (dispatches rich action to reducer) ---
  const navigateToAmenityByName = useCallback((amenityName: string) => {
    const match = amenities.find((a) => {
      const n = a.name.toLowerCase()
      const s = a.scene.toLowerCase()
      return n.includes(amenityName) || s.includes(amenityName)
    })

    if (!match) {
      // No match — speak directly (no state change needed)
      interrupt()
      repeat(`I don't think we have a ${amenityName} at this property. Would you like to see the rooms, or explore the surrounding area?`).catch(() => undefined)
      return
    }

    // Track this amenity visit + start timer
    trackAmenityExplored(match.name)
    startAmenityTimer(match.name)

    // Dispatch rich action — reducer handles UE5 commands, fade, speech, and state transition
    dispatch({
      type: "NAVIGATE_TO_AMENITY",
      amenity: { id: match.id, name: match.name, scene: match.scene },
      narrative: buildAmenityNarrative(match.name, match.scene),
      visitedAmenities: getVisitedAmenityNames(),
      allAmenities: amenityRefs,
    })
  }, [amenities, amenityRefs, trackAmenityExplored, startAmenityTimer, getVisitedAmenityNames, interrupt, repeat, dispatch])

  /** Handle dynamic room plan adjustments (budget, compact, distribution change) */
  const handlePlanAdjustment = useCallback((
    mode: "budget" | "compact" | "distribution",
    _message: string,
    allocationOverride?: number[],
  ) => {
    const partySize = profile.familySize ?? derivedProfile.partySize
    if (!partySize || rooms.length === 0) return

    let newPlan: RoomPlan | null = null
    let speechText = ""

    if (mode === "budget") {
      newPlan = getBudgetRoomPlan(rooms, partySize, profile.roomAllocation)
      if (newPlan) {
        const summary = newPlan.entries
          .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
          .join(" and ")
        speechText = `Here's a more budget-friendly option: ${summary} at $${newPlan.totalPricePerNight.toLocaleString()} per night. How does that look?`
      }
    } else if (mode === "compact") {
      newPlan = getCompactRoomPlan(rooms, partySize)
      if (newPlan) {
        const roomCount = newPlan.entries.reduce((sum, e) => sum + e.quantity, 0)
        const summary = newPlan.entries
          .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
          .join(" and ")
        speechText = `I've packed your group into ${roomCount} room${roomCount > 1 ? "s" : ""}: ${summary} at $${newPlan.totalPricePerNight.toLocaleString()} per night. What do you think?`
      }
    } else if (mode === "distribution") {
      const allocation = allocationOverride ?? profile.roomAllocation
      newPlan = getRecommendedRoomPlan(
        rooms, partySize, profile.guestComposition, profile.travelPurpose, profile.budgetRange, undefined, allocation,
      )
      if (newPlan) {
        const roomCount = newPlan.entries.reduce((sum, e) => sum + e.quantity, 0)
        const summary = newPlan.entries
          .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
          .join(" and ")
        speechText = `Here's the updated layout: ${summary} — ${roomCount} room${roomCount > 1 ? "s" : ""} at $${newPlan.totalPricePerNight.toLocaleString()} per night.`
      }
    }

    if (newPlan) {
      interrupt()
      repeat(speechText).catch(() => undefined)
      executeEffects([{ type: "UPDATE_ROOM_PLAN", plan: newPlan }])
      // Ensure the rooms panel is open
      if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
        executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }])
        stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
      }
    }
  }, [profile, derivedProfile, rooms, interrupt, repeat, executeEffects])

  /** Handle explicit room composition from user (e.g., "4 standard rooms and 2 loft suites") */
  const handleExplicitComposition = useCallback((
    requests: { roomId: string; quantity: number }[],
  ) => {
    const partySize = profile.familySize ?? derivedProfile.partySize
    const { plan, warning } = buildExplicitRoomPlan(requests, rooms, partySize)

    if (plan.entries.length === 0) {
      interrupt()
      repeat("I couldn't quite match those room types. Could you describe the combination you'd like?").catch(() => undefined)
      return
    }

    const summary = plan.entries
      .map((e) => `${e.quantity} ${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
      .join(" and ")

    let speechText = `Got it — ${summary} at $${plan.totalPricePerNight.toLocaleString()} per night total.`
    if (warning) {
      speechText += ` Just a heads up: ${warning}`
    } else {
      speechText += " How does that look?"
    }

    interrupt()
    repeat(speechText).catch(() => undefined)
    executeEffects([{ type: "UPDATE_ROOM_PLAN", plan }])

    // Ensure the rooms panel is open
    if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
      executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }])
      stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
    }
  }, [profile, derivedProfile, rooms, interrupt, repeat, executeEffects])

  /** Dispatch LIST_AMENITIES action with pre-computed hotel data */
  const dispatchListAmenities = useCallback(() => {
    const recommended = getRecommendedAmenity(amenities, profile.travelPurpose)
    dispatch({
      type: "LIST_AMENITIES",
      visitedAmenities: getVisitedAmenityNames(),
      allAmenities: amenityRefs,
      travelPurpose: profile.travelPurpose,
      recommendedAmenityName: recommended?.name,
    })
  }, [amenities, amenityRefs, profile.travelPurpose, getVisitedAmenityNames, dispatch])

  // --- Idle detection (re-engagement) ---
  const handleIdle = useCallback(() => {
    dispatch({ type: "IDLE_TIMEOUT" })
  }, [dispatch])

  useIdleDetection({
    journeyStage,
    onIdle: handleIdle,
    hooks: options.avatarHooks ? { useContext: options.avatarHooks.useContext } : undefined,
  })

  // --- React to profile changes ---
  useEffect(() => {
    const profileKey = JSON.stringify({
      partySize: derivedProfile.partySize ?? profile.familySize,
      guestComposition: derivedProfile.guestComposition ?? profile.guestComposition,
      startDate: derivedProfile.startDate?.toISOString(),
      endDate: derivedProfile.endDate?.toISOString(),
      interests: derivedProfile.interests,
      travelPurpose: derivedProfile.travelPurpose ?? profile.travelPurpose,
      pending: isExtractionPending,
    })

    if (profileKey === lastProfileKeyRef.current) return
    lastProfileKeyRef.current = profileKey

    // Profile changed — reset nudge counters so HeyGen gets fresh runway
    avatarMsgsSinceProfileChangeRef.current = 0

    // Merge conversation-extracted profile with pre-seeded context values
    // so that returning-user defaults (e.g. guestComposition) are visible
    // to the journey machine even before the user explicitly restates them.
    const mergedProfile = {
      ...derivedProfile,
      partySize: derivedProfile.partySize ?? profile.familySize,
      guestComposition: derivedProfile.guestComposition ?? profile.guestComposition,
      travelPurpose: derivedProfile.travelPurpose ?? profile.travelPurpose,
      roomAllocation: derivedProfile.roomAllocation ?? profile.roomAllocation,
    }

    const doDispatch = () => {
      dispatch({
        type: "PROFILE_UPDATED",
        profile: mergedProfile,
        firstName: profile.firstName,
        isExtractionPending,
      })
    }

    // Debounce during PROFILE_COLLECTION so compound answers from
    // HeyGen's VAD splitting settle before evaluating profile completeness.
    // Exception: when all required fields are present, dispatch immediately
    // so HeyGen's AI persona doesn't keep asking follow-up questions.
    if (stateRef.current.stage === "PROFILE_COLLECTION") {
      const profileReady = !isExtractionPending
        && mergedProfile.startDate && mergedProfile.endDate
        && mergedProfile.partySize && mergedProfile.guestComposition
        && mergedProfile.travelPurpose
        && ((mergedProfile.partySize ?? 1) <= 1 || mergedProfile.roomAllocation)

      if (profileReady) {
        if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
        doDispatch()
        return
      }

      if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
      profileDebounceRef.current = setTimeout(doDispatch, 2500)
      return () => {
        if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
      }
    }

    doDispatch()
  }, [derivedProfile, isExtractionPending, profile.firstName, profile.familySize, profile.guestComposition, profile.travelPurpose, profile.roomAllocation, dispatch])

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

    // --- Global intents — check before stage-specific routing ---
    const earlyIntent = classifyIntent(latestMessage)
    if (earlyIntent.type === "END_EXPERIENCE" || earlyIntent.type === "RETURN_TO_LOUNGE") {
      dispatch({ type: "USER_INTENT", intent: earlyIntent })
      return
    }

    // --- END_CONFIRMING: intercept yes/no for farewell confirmation ---
    if (stateRef.current.stage === "END_CONFIRMING") {
      const confirmIntent = classifyIntent(latestMessage)
      if (confirmIntent.type === "AFFIRMATIVE" || confirmIntent.type === "NEGATIVE") {
        dispatch({ type: "USER_INTENT", intent: confirmIntent })
      }
      return
    }

    // --- LOUNGE_CONFIRMING: intercept yes/no for lounge return confirmation ---
    if (stateRef.current.stage === "LOUNGE_CONFIRMING") {
      const confirmIntent = classifyIntent(latestMessage)
      if (confirmIntent.type === "AFFIRMATIVE" || confirmIntent.type === "NEGATIVE") {
        dispatch({ type: "USER_INTENT", intent: confirmIntent })
      }
      return
    }

    // Only classify intent when we're in a stage that cares about voice input
    const stage = stateRef.current.stage

    // During PROFILE_COLLECTION, check if the user wants to move forward
    // (covers the case where HeyGen's AI advances the conversation before our extraction catches up)
    if (stage === "PROFILE_COLLECTION") {
      const intent = classifyIntent(latestMessage)
      if (intent.type === "TRAVEL_TO_HOTEL" || intent.type === "AFFIRMATIVE") {
        dispatch({ type: "FORCE_ADVANCE" })
      }
      return
    }

    if (stage === "DESTINATION_SELECT") return

    // In the virtual lounge, skip budget/amenity interception — just dispatch intent directly
    if (stage === "VIRTUAL_LOUNGE") {
      const intent = classifyIntent(latestMessage)
      dispatch({ type: "USER_INTENT", intent })
      return
    }

    const currentState = stateRef.current

    // --- Voice-driven room selection (before intent classification) ---
    // When the rooms panel is open, try to fuzzy-match the raw utterance
    // against available room names. This lets users say things like
    // "the mountain view", "show me the penthouse", "loft suite lake" etc.
    if (
      currentState.stage === "HOTEL_EXPLORATION" &&
      currentState.subState === "panel_open"
    ) {
      const matched = matchRoomByName(latestMessage, rooms)
      if (matched) {
        eventBus.emit({
          type: "ROOM_CARD_TAPPED",
          roomId: matched.id,
          roomName: matched.name,
          occupancy: matched.occupancy,
        })
        return
      }
      // No match — fall through to normal intent classification
      // (the user might be saying "go back", "show amenities", etc.)
    }

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
      (intent.type === "BACK" || intent.type === "ROOMS" || intent.type === "LOCATION" || intent.type === "HOTEL_EXPLORE" || intent.type === "TRAVEL_TO_HOTEL")
    ) {
      stopExplorationTimer()
    }

    // --- Intercept amenity intents (need hotel data → dispatch rich actions) ---

    // "amenities" or "other options" while viewing → list amenities via reducer
    if (intent.type === "AMENITIES" || (intent.type === "OTHER_OPTIONS" && stage === "AMENITY_VIEWING")) {
      stopExplorationTimer()
      dispatchListAmenities()
      return
    }

    // Specific amenity by name → navigate via reducer
    if (intent.type === "AMENITY_BY_NAME") {
      navigateToAmenityByName(intent.amenityName)
      return
    }

    // Bare "yes" → resolve against suggested amenity in state
    if (intent.type === "AFFIRMATIVE") {
      // Check AMENITY_VIEWING suggestedNext
      if (currentState.stage === "AMENITY_VIEWING" && currentState.suggestedNext) {
        navigateToAmenityByName(currentState.suggestedNext)
        return
      }
      // Check HOTEL_EXPLORATION suggestedAmenityName
      if (currentState.stage === "HOTEL_EXPLORATION" && currentState.suggestedAmenityName) {
        navigateToAmenityByName(currentState.suggestedAmenityName)
        return
      }
    }

    // --- Intercept room plan adjustment intents (panel must be open or in exploration) ---
    const isRoomContext = currentState.stage === "HOTEL_EXPLORATION" || currentState.stage === "ROOM_SELECTED"

    if (isRoomContext && intent.type === "ROOM_PLAN_CHEAPER") {
      handlePlanAdjustment("budget", latestMessage)
      return
    }

    if (isRoomContext && intent.type === "ROOM_PLAN_COMPACT") {
      handlePlanAdjustment("compact", latestMessage)
      return
    }

    // Distribution change while panel is open → convert to allocation and recompute
    if (isRoomContext && (intent.type === "ROOM_TOGETHER" || intent.type === "ROOM_SEPARATE")) {
      const partySize = profile.familySize ?? derivedProfile.partySize ?? 1
      const newAllocation = intent.type === "ROOM_TOGETHER"
        ? [partySize]
        : Array(partySize).fill(1)
      updateProfile({ roomAllocation: newAllocation })
      handlePlanAdjustment("distribution", latestMessage, newAllocation)
      return
    }

    // --- Try to parse explicit room composition from the raw message ---
    if (isRoomContext && (intent.type === "UNKNOWN" || intent.type === "ROOMS")) {
      const explicitRequests = parseExplicitRoomRequests(latestMessage, rooms)
      if (explicitRequests && explicitRequests.length > 0) {
        handleExplicitComposition(explicitRequests)
        return
      }
    }

    dispatch({ type: "USER_INTENT", intent })
  }, [userMessages, dispatch, trackQuestion, trackRequirement, dispatchListAmenities, navigateToAmenityByName, startRoomTimer, stopExplorationTimer, profile, derivedProfile, rooms, interrupt, repeat, handlePlanAdjustment, handleExplicitComposition])

  // --- React to new avatar messages (proposal classification + profile nudges) ---
  useEffect(() => {
    const avatarMessages = allMessages.filter((m) => m.sender === MessageSender.AVATAR)
    if (avatarMessages.length <= lastAvatarMessageCountRef.current) return
    lastAvatarMessageCountRef.current = avatarMessages.length

    const latestAvatarMessage = avatarMessages[avatarMessages.length - 1]?.message ?? ""
    const currentState = stateRef.current

    // --- Profile nudge: steer HeyGen back when it forgets missing fields ---
    if (currentState.stage === "PROFILE_COLLECTION" && currentState.awaiting !== "ready" && currentState.awaiting !== "extracting") {
      avatarMsgsSinceProfileChangeRef.current++

      // Reset nudge escalation when the awaiting field changes (new data captured)
      if (nudgeAwaitingRef.current !== currentState.awaiting) {
        nudgeAwaitingRef.current = currentState.awaiting
        nudgeCountRef.current = 0
      }

      const now = Date.now()
      const cooldownMs = 15_000
      const avatarMsgsThreshold = 2

      if (
        avatarMsgsSinceProfileChangeRef.current >= avatarMsgsThreshold &&
        now - nudgeLastSentRef.current > cooldownMs
      ) {
        const nudgeText = buildProfileNudge(
          currentState.awaiting,
          derivedProfile,
          nudgeCountRef.current,
        )
        if (nudgeText) {
          message(nudgeText)
          nudgeLastSentRef.current = now
          nudgeCountRef.current++
          avatarMsgsSinceProfileChangeRef.current = 0
        }
      }
    }

    // --- Proposal classification (only in stages that use lastProposal) ---
    const stage = currentState.stage
    if (stage !== "HOTEL_EXPLORATION" && stage !== "ROOM_SELECTED" && stage !== "AMENITY_VIEWING") return

    const proposal = classifyAvatarProposal(latestAvatarMessage)
    if (proposal) {
      dispatch({ type: "AVATAR_PROPOSAL", proposal: proposal.proposal, amenityName: proposal.amenityName })
    }
  }, [allMessages, dispatch, derivedProfile, message])

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
      visitedAmenities: getVisitedAmenityNames(),
      allAmenities: amenityRefs,
    })
  })

  useEventListener("NAVIGATE_BACK", () => {
    stopExplorationTimer()
    dispatch({ type: "USER_INTENT", intent: { type: "BACK" } })
  })

  return { dispatch, getInternalState }
}
