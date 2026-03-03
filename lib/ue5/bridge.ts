"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useUE5WebSocket, type UE5IncomingMessage, type UnitSelectionMessage } from "@/lib/useUE5WebSocket"
import { useEventBus } from "@/lib/events"
import type { SunState } from "@/components/SunToggle"

// ---------------------------------------------------------------------------
// UE5 Bridge — high-level wrapper around the raw WebSocket
// ---------------------------------------------------------------------------
// Encapsulates:
//   - Typed commands (navigateToRooms, selectRoom, etc.)
//   - Fade overlay state and animation logic
//   - Forwarding incoming UE5 events to the EventBus
// ---------------------------------------------------------------------------

export type UE5BridgeState = {
  isConnected: boolean
  showFadeOverlay: boolean
  isFadeOpaque: boolean
  selectedUnit: UnitSelectionMessage | null
  sunState: SunState
}

export function useUE5Bridge() {
  const eventBus = useEventBus()

  // --- Fade overlay state (extracted from old HomePage) ---
  const [showFadeOverlay, setShowFadeOverlay] = useState(false)
  const [isFadeOpaque, setIsFadeOpaque] = useState(false)
  const fadeTimeoutsRef = useRef<number[]>([])

  // --- Unit selection state ---
  const [selectedUnit, setSelectedUnit] = useState<UnitSelectionMessage | null>(null)
  const [sunState, setSunState] = useState<SunState>("daylight")

  const clearFadeTimeouts = useCallback(() => {
    fadeTimeoutsRef.current.forEach((id) => window.clearTimeout(id))
    fadeTimeoutsRef.current = []
  }, [])

  const fadeTransition = useCallback(() => {
    clearFadeTimeouts()
    setIsFadeOpaque(false)
    setShowFadeOverlay(true)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setIsFadeOpaque(true)
      })
    })

    const midpointTimeout = window.setTimeout(() => {
      setIsFadeOpaque(false)
    }, 2000)

    const endTimeout = window.setTimeout(() => {
      setShowFadeOverlay(false)
    }, 3000)

    fadeTimeoutsRef.current = [midpointTimeout, endTimeout]
  }, [clearFadeTimeouts])

  useEffect(() => {
    return () => clearFadeTimeouts()
  }, [clearFadeTimeouts])

  // --- WebSocket handlers ---
  const handleUE5Message = useCallback((msg: UE5IncomingMessage) => {
    console.log("UE5 message received:", msg)
  }, [])

  const handleUnitSelected = useCallback((unit: UnitSelectionMessage) => {
    setSelectedUnit(unit)
    eventBus.emit({
      type: "UNIT_SELECTED_UE5",
      roomName: unit.roomName,
      description: unit.description,
      price: unit.price,
      level: unit.level,
    })
  }, [eventBus])

  const { isConnected, sendRawMessage } = useUE5WebSocket({
    onMessage: handleUE5Message,
    onUnitSelected: handleUnitSelected,
  })

  // --- Typed commands ---
  const sendCommand = useCallback((type: string, value: unknown) => {
    sendRawMessage({ type, value })
  }, [sendRawMessage])

  const navigateToRooms = useCallback(() => {
    sendCommand("gameEstate", "rooms")
  }, [sendCommand])

  const navigateToAmenities = useCallback(() => {
    sendCommand("gameEstate", "amenities")
  }, [sendCommand])

  const navigateToLocation = useCallback(() => {
    sendCommand("gameEstate", "location")
  }, [sendCommand])

  const resetToDefault = useCallback(() => {
    sendCommand("gameEstate", "default")
  }, [sendCommand])

  const selectRoom = useCallback((roomId: string) => {
    sendCommand("selectedRoom", roomId)
  }, [sendCommand])

  const viewUnit = useCallback((view: "interior" | "exterior") => {
    sendCommand("unitView", view)
  }, [sendCommand])

  const navigateToAmenity = useCallback((amenityId: string) => {
    sendCommand("communal", amenityId)
  }, [sendCommand])

  const changeSunPosition = useCallback((state: SunState) => {
    setSunState(state)
    sendCommand("sunPosition", state)
  }, [sendCommand])

  const startTest = useCallback(() => {
    sendCommand("startTEST", "startTEST")
  }, [sendCommand])

  const clearSelectedUnit = useCallback(() => {
    setSelectedUnit(null)
  }, [])

  return {
    // State
    isConnected,
    showFadeOverlay,
    isFadeOpaque,
    selectedUnit,
    sunState,

    // Commands
    sendCommand,
    navigateToRooms,
    navigateToAmenities,
    navigateToLocation,
    resetToDefault,
    selectRoom,
    viewUnit,
    navigateToAmenity,
    changeSunPosition,
    startTest,
    clearSelectedUnit,

    // Transitions
    fadeTransition,
  }
}
