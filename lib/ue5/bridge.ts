"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useUE5WebSocket, type UE5IncomingMessage, type UnitSelectionMessage } from "@/lib/useUE5WebSocket"
import type { SunState } from "@/components/SunToggle"

// ---------------------------------------------------------------------------
// UE5 Bridge — high-level wrapper around the raw WebSocket
// ---------------------------------------------------------------------------
// Encapsulates:
//   - Typed commands (navigateToRooms, selectRoom, etc.)
//   - Fade overlay state and animation logic
//   - Forwarding incoming UE5 unit selections to the caller via a direct
//     callback (Phase 8: no EventBus hop).
// ---------------------------------------------------------------------------

export type UE5BridgeState = {
  isConnected: boolean
  /** True once UE5 has sent its FIRST message — the definitive "the pixel
   *  stream is alive and the level is loaded" signal (stronger than the
   *  transport-only `isConnected`). Matches the old /home `ue5Ready` gate;
   *  fires for both Vagon (onApplicationMessage) and local (ws.onmessage). */
  isReady: boolean
  /** True once UE5 has emitted the `ue5Init` token (Blueprint on WebSocket
   *  OnConnected) — "the experience is connected". Used to gate the avatar boot
   *  in vagon mode, where the UE5 stream launches slowly. */
  initialized: boolean
  /** Increments each time UE5 reports a level has finished loading. Consumers
   *  watch it to pull the unit inventory at the reliable moment (units exist). */
  levelLoadedSeq: number
  showFadeOverlay: boolean
  isFadeOpaque: boolean
  selectedUnit: UnitSelectionMessage | null
  sunState: SunState
}

export type UE5BridgeOptions = {
  /**
   * Phase 8: called when UE5 reports that the user selected a unit in the 3D
   * scene. Previously this fired a `UNIT_SELECTED_UE5` event on the EventBus.
   * `/home` now wires it directly to `useJourney().onUnitSelectedUE5`.
   */
  onUnitSelected?: (payload: {
    /** UnitID of the tapped unit (multi-unit contract). Absent on older UE5. */
    id?: number
    roomName: string
    description?: string
    price?: string
    level?: string
  }) => void
  /** Called when UE5 pushes its physical-unit inventory (raw — normalize via
   *  lib/selection). May arrive chunked (chunk/total); the consumer accumulates.
   *  Fires on scene-ready and on requestInventory. */
  onUnitInventory?: (msg: { units: unknown[]; chunk?: number; total?: number }) => void
}

// TEMP DIAGNOSTIC: trace who fires each scene nav, so out-of-order sends (a deferred
// area-level gameEstate landing AFTER a specific target like communal/selectUnits) can
// be pinned to the tool that scheduled it. The session's tool-call log (🛠️) just above
// names the tool; these frames name the dispatcher call site. Remove once confirmed.
function diagScene(label: string) {
  const frames = new Error().stack?.split("\n").slice(2, 5).map((s) => s.trim()).join("  ⟵  ")
  console.log(`[ue5][diag] ${label}`, frames)
}

export function useUE5Bridge(opts: UE5BridgeOptions = {}) {
  // Stable ref to the latest `onUnitSelected` callback so `handleUnitSelected`
  // (a useCallback) stays referentially stable even when callers pass a new
  // function each render. WebSocket hook wiring stays quiet.
  const onUnitSelectedRef = useRef(opts.onUnitSelected)
  const onUnitInventoryRef = useRef(opts.onUnitInventory)
  useEffect(() => {
    onUnitSelectedRef.current = opts.onUnitSelected
    onUnitInventoryRef.current = opts.onUnitInventory
  })

  // --- Fade overlay state (extracted from old HomePage) ---
  const [showFadeOverlay, setShowFadeOverlay] = useState(false)
  const [isFadeOpaque, setIsFadeOpaque] = useState(false)
  const fadeTimeoutsRef = useRef<number[]>([])

  // --- Unit selection state ---
  const [selectedUnit, setSelectedUnit] = useState<UnitSelectionMessage | null>(null)
  const [sunState, setSunState] = useState<SunState>("daylight")

  // --- UE5 readiness (first inbound message) ---
  const [isReady, setIsReady] = useState(false)
  // --- UE5 "experience connected" (the explicit `ue5Init` token). Gates the
  //     avatar boot in vagon mode (UE5 launches slowly there). ---
  const [initialized, setInitialized] = useState(false)
  // --- Hotel level fully loaded (units exist); a counter so each load re-fires
  //     consumers even across return-to-lounge → re-travel. ---
  const [levelLoadedSeq, setLevelLoadedSeq] = useState(0)

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
    setIsReady(true)
  }, [])

  const handleUe5Init = useCallback(() => {
    console.log("UE5 init received — experience connected")
    setInitialized(true)
    setIsReady(true)
  }, [])

  const handleUnitSelected = useCallback((unit: UnitSelectionMessage) => {
    setIsReady(true)
    setSelectedUnit(unit)
    onUnitSelectedRef.current?.({
      id: unit.id,
      roomName: unit.roomName,
      description: unit.description,
      price: unit.price,
      level: unit.level,
    })
  }, [])

  const handleUnitInventory = useCallback((msg: { units: unknown[]; chunk?: number; total?: number }) => {
    setIsReady(true)
    onUnitInventoryRef.current?.(msg)
  }, [])

  const handleLevelLoaded = useCallback(() => {
    setIsReady(true)
    setLevelLoadedSeq((n) => n + 1)
  }, [])

  const { isConnected, sendRawMessage } = useUE5WebSocket({
    onMessage: handleUE5Message,
    onUnitSelected: handleUnitSelected,
    onUnitInventory: handleUnitInventory,
    onLevelLoaded: handleLevelLoaded,
    onUe5Init: handleUe5Init,
  })

  // --- Typed commands ---
  const sendCommand = useCallback((type: string, value: unknown) => {
    sendRawMessage({ type, value })
  }, [sendRawMessage])

  const navigateToRooms = useCallback(() => {
    diagScene("gameEstate:rooms")
    sendCommand("gameEstate", "rooms")
  }, [sendCommand])

  const navigateToAmenities = useCallback(() => {
    diagScene("gameEstate:amenities")
    sendCommand("gameEstate", "amenities")
  }, [sendCommand])

  const navigateToLocation = useCallback(() => {
    diagScene("gameEstate:location")
    sendCommand("gameEstate", "location")
  }, [sendCommand])

  const resetToDefault = useCallback(() => {
    diagScene("gameEstate:default")
    sendCommand("gameEstate", "default")
  }, [sendCommand])

  const selectRoom = useCallback((roomId: string) => {
    sendCommand("selectedRoom", roomId)
  }, [sendCommand])

  // Authoritative multi-unit highlight: the green set + the single focused unit.
  // The frontend owns the FIFO bucket logic; UE5 just renders this set.
  // `focus` is emitted as -1 (never null) when there's no active unit, so UE5's
  // Blueprint `Get Integer Field "focus"` always succeeds; UE5 treats focus < 0 as
  // "clear focus" and focus >= 0 as "look up that unit".
  const selectUnits = useCallback((unitIds: number[], focus: number | null) => {
    sendRawMessage({ type: "selectUnits", value: unitIds.join(","), focus: focus ?? -1 })
  }, [sendRawMessage])

  // Optional pull — ask UE5 to (re)send its full unit inventory.
  const requestInventory = useCallback(() => {
    sendRawMessage({ type: "requestInventory" })
  }, [sendRawMessage])

  const viewUnit = useCallback((view: "interior" | "exterior") => {
    sendCommand("unitView", view)
  }, [sendCommand])

  const navigateToAmenity = useCallback((amenityId: string) => {
    diagScene(`communal:${amenityId}`)
    sendCommand("communal", amenityId)
  }, [sendCommand])

  const changeSunPosition = useCallback((state: SunState) => {
    setSunState(state)
    sendCommand("sunPosition", state)
  }, [sendCommand])

  const startTest = useCallback(() => {
    sendCommand("startTEST", "startTEST")
  }, [sendCommand])

  // POI markers for the OSM scene. UE5's AOSMInterestPointsManager.Initialise
  // expects a JSON STRING (not an object), so callers must JSON.stringify the
  // `{ points: [...] }` payload before passing it in.
  const sendOSMData = useCallback((pointsJson: string) => {
    sendCommand("osm_data", pointsJson)
  }, [sendCommand])

  const clearSelectedUnit = useCallback(() => {
    setSelectedUnit(null)
  }, [])

  // Tells UE5 to force-release any held mouse input. Sent when the user
  // finishes a pointer gesture over parent-DOM — cross-origin iframes don't
  // forward `mouseup` back to UE5, so without this the orbit camera stays
  // stuck in drag mode. Idempotent on the UE5 side (no-op when nothing held).
  const releaseInput = useCallback(() => {
    sendRawMessage({ type: "inputRelease" })
  }, [sendRawMessage])

  return {
    // State
    isConnected,
    isReady,
    initialized,
    levelLoadedSeq,
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
    selectUnits,
    requestInventory,
    viewUnit,
    navigateToAmenity,
    changeSunPosition,
    startTest,
    sendOSMData,
    clearSelectedUnit,
    releaseInput,

    // Transitions
    fadeTransition,
  }
}
