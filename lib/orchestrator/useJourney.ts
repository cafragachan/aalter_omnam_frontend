"use client"

import { useCallback, useEffect, useRef } from "react"
import { useUserProfileContext } from "@/lib/context"
import { useUserProfile } from "@/lib/liveavatar"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useEventBus, useEventListener } from "@/lib/events"
import { classifyIntent } from "./intents"
import { journeyReducer, INITIAL_JOURNEY_STATE } from "./journey-machine"
import type { JourneyState, JourneyAction, JourneyEffect } from "./types"

// ---------------------------------------------------------------------------
// useJourney — wires the pure state machine to React
// ---------------------------------------------------------------------------
// Replaces the old JourneyOrchestrator component (330 lines of useEffects).
// Single hook that:
//   1. Listens to profile changes, user messages, and EventBus events
//   2. Feeds them through classifyIntent + journeyReducer
//   3. Executes the resulting effects (avatar speak, UE5 commands, etc.)
// ---------------------------------------------------------------------------

type UseJourneyOptions = {
  /** Callback to open a UI panel */
  onOpenPanel: (panel: "rooms" | "amenities" | "location") => void
  /** Callback to close all UI panels */
  onClosePanels: () => void
  /** Callback to send a command to UE5 */
  onUE5Command: (command: string, value: unknown) => void
  /** Callback to reset UE5 to default view */
  onResetToDefault: () => void
  /** Callback to trigger a fade transition */
  onFadeTransition: () => void
  /** Callback when a unit is selected (to update local UI state) */
  onUnitSelected?: (roomName: string) => void
}

export function useJourney(options: UseJourneyOptions) {
  const {
    onOpenPanel,
    onClosePanels,
    onUE5Command,
    onResetToDefault,
    onFadeTransition,
  } = options

  const { profile, journeyStage, setJourneyStage } = useUserProfileContext()
  const { profile: derivedProfile, isExtractionPending, userMessages } = useUserProfile()
  const { repeat, interrupt } = useAvatarActions("FULL")
  const eventBus = useEventBus()

  // --- State machine state (kept in ref to avoid re-render cascades) ---
  const stateRef = useRef<JourneyState>(INITIAL_JOURNEY_STATE)
  const lastMessageCountRef = useRef(0)
  const lastProfileKeyRef = useRef("")
  const destinationAnnouncedRef = useRef(false)

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
      }
    }
  }, [interrupt, repeat, onUE5Command, onOpenPanel, onClosePanels, onFadeTransition, setJourneyStage, onResetToDefault])

  // --- Dispatch helper ---
  const dispatch = useCallback((action: JourneyAction) => {
    const result = journeyReducer(stateRef.current, action)
    stateRef.current = result.nextState
    if (result.effects.length > 0) {
      executeEffects(result.effects)
    }
  }, [executeEffects])

  // --- React to profile changes ---
  useEffect(() => {
    const profileKey = JSON.stringify({
      partySize: derivedProfile.partySize,
      startDate: derivedProfile.startDate?.toISOString(),
      endDate: derivedProfile.endDate?.toISOString(),
      interests: derivedProfile.interests,
      pending: isExtractionPending,
    })

    if (profileKey === lastProfileKeyRef.current) return
    lastProfileKeyRef.current = profileKey

    dispatch({
      type: "PROFILE_UPDATED",
      profile: derivedProfile,
      firstName: profile.firstName,
      isExtractionPending,
    })
  }, [derivedProfile, isExtractionPending, profile.firstName, dispatch])

  // --- React to new user messages (intent classification) ---
  useEffect(() => {
    if (userMessages.length <= lastMessageCountRef.current) return
    lastMessageCountRef.current = userMessages.length

    // Only classify intent when we're in a stage that cares about voice input
    const stage = stateRef.current.stage
    if (stage === "PROFILE_COLLECTION" || stage === "DESTINATION_SELECT") return

    const latestMessage = userMessages[userMessages.length - 1]?.message ?? ""
    const intent = classifyIntent(latestMessage)

    dispatch({ type: "USER_INTENT", intent })
  }, [userMessages, dispatch])

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
        "Wonderful! Based on your preferences, let me show you some available options I think you'll love. Take a look at these properties. Tap any card to explore the digital twin.",
      ).catch(() => undefined)
    }, 500)
    return () => clearTimeout(timer)
  }, [journeyStage, interrupt, repeat])

  // --- EventBus subscriptions ---

  useEventListener("HOTEL_SELECTED", (event) => {
    // Hotel data lookup is done by the caller; we receive the enriched event
    // This is dispatched from the DestinationsOverlay panel
    dispatch({
      type: "HOTEL_PICKED",
      slug: event.slug,
      hotelName: "", // filled by the panel component
      location: "",
      description: "",
    })
  })

  useEventListener("ROOM_CARD_TAPPED", (event) => {
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
    dispatch({
      type: "AMENITY_CARD_TAPPED",
      name: event.name,
      scene: event.scene,
      amenityId: event.amenityId,
    })
  })

  useEventListener("NAVIGATE_BACK", () => {
    dispatch({ type: "USER_INTENT", intent: { type: "BACK" } })
  })

  // --- Public API ---
  return {
    /** Dispatch an action directly (useful for hotel selection with enriched data) */
    dispatch,
  }
}
