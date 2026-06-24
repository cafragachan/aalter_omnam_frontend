"use client"

import { useCallback, useEffect, useRef, useState } from "react"
// Types from lib/vagon.d.ts are picked up automatically by TypeScript

export type UE5MessageType =
  | "startTEST"
  | "gameEstate"
  | "selectedRoom"
  | "selectUnits"
  | "requestInventory"
  | "selectedAmenity"
  | "unitView"
  | "sunPosition"
  | "hotelSelected"
  | "profileUpdate"
  | "osm_data"
  | "inputRelease"

export type UE5IncomingMessage = {
  type: string
  [key: string]: unknown
}

export type UnitSelectionMessage = {
  type: "unit"
  /** UnitID of the tapped unit (added with the multi-unit contract). Lets the
   *  frontend correlate a tap to an inventory entry. May be absent on older UE5. */
  id?: number
  roomName: string
  description?: string
  price?: string
  level?: string
}

/** Full physical-unit inventory pushed by UE5 on scene-ready (or on our
 *  requestInventory ping). `units` is raw — normalize via lib/selection. */
export type UnitInventoryMessage = {
  type: "unitInventory"
  units: unknown[]
  /** Chunking: index of this chunk and total chunk count. Absent / total<=1 means
   *  the whole inventory is in this single message. UE5 chunks large catalogs so
   *  the per-message size limit on the channel doesn't drop the payload. */
  chunk?: number
  total?: number
}

type UseUE5WebSocketOptions = {
  url?: string
  autoConnect?: boolean
  onMessage?: (message: UE5IncomingMessage) => void
  onUnitSelected?: (unit: UnitSelectionMessage) => void
  onUnitInventory?: (msg: { units: unknown[]; chunk?: number; total?: number }) => void
  /** UE5 reports the hotel level has FINISHED loading (units now exist). The
   *  reliable moment to pull the unit inventory — arrival fires while the map is
   *  still loading. */
  onLevelLoaded?: () => void
  /** UE5 emits the bare token `ue5Init` from a Blueprint bound to its WebSocket
   *  OnConnected event — the definitive "the experience is connected" signal.
   *  Used to gate the avatar boot in vagon mode (where UE5 launches slowly). */
  onUe5Init?: () => void
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Event) => void
}

export type UE5WebSocketState = {
  isConnected: boolean
  isConnecting: boolean
  error: string | null
}

const STREAM_MODE = process.env.NEXT_PUBLIC_STREAM_MODE || "local"

export const useUE5WebSocket = (options: UseUE5WebSocketOptions = {}) => {
  const {
    url = "ws://localhost:7788",
    autoConnect = true,
    onMessage,
    onUnitSelected,
    onUnitInventory,
    onLevelLoaded,
    onUe5Init,
    onConnect,
    onDisconnect,
    onError,
  } = options

  const websocketRef = useRef<WebSocket | null>(null)
  const [state, setState] = useState<UE5WebSocketState>({
    isConnected: false,
    isConnecting: false,
    error: null,
  })

  const normalizeIncomingMessage = useCallback(async (data: unknown): Promise<UE5IncomingMessage[]> => {
    let messageData = data

    // Handle Blob data
    if (data instanceof Blob) {
      messageData = await data.text()
    }

    if (typeof messageData === "string") {
      const trimmed = messageData.trim()
      if (!trimmed) return []

      try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        // UE5 sometimes sends a BARE token (e.g. "levelLoaded") instead of a JSON
        // object. Treat a simple non-JSON string as a typed signal message so
        // handlers (levelLoaded, etc.) can still react to it.
        if (trimmed[0] !== "{" && trimmed[0] !== "[") {
          return [{ type: trimmed }]
        }
        console.warn("Failed to parse UE5 message as JSON:", { data: messageData })
        return []
      }
    }

    if (typeof messageData === "object" && messageData !== null) {
      return [messageData as UE5IncomingMessage]
    }

    return []
  }, [])

  const isUnitSelectionMessage = useCallback((value: unknown): value is UnitSelectionMessage => {
    if (!value || typeof value !== "object") return false
    const payload = value as Record<string, unknown>
    return payload.type === "unit" && typeof payload.roomName === "string"
  }, [])

  const isUnitInventoryMessage = useCallback((value: unknown): value is UnitInventoryMessage => {
    if (!value || typeof value !== "object") return false
    const payload = value as Record<string, unknown>
    return payload.type === "unitInventory" && Array.isArray(payload.units)
  }, [])

  // ---------------------------------------------------------------------------
  // Vagon SDK message handler (shared with WebSocket path)
  // ---------------------------------------------------------------------------
  const handleIncomingPayloads = useCallback((messages: UE5IncomingMessage[]) => {
    messages.forEach((payload) => {
      console.log("Message from UE5:", payload)

      if (payload?.type === "ue5Init") {
        onUe5Init?.()
        onMessage?.(payload) // keep readiness/logging behavior
        return
      }

      if (payload?.type === "levelLoaded") {
        onLevelLoaded?.()
        onMessage?.(payload) // keep readiness/logging behavior
        return
      }

      if (isUnitInventoryMessage(payload)) {
        onUnitInventory?.({ units: payload.units, chunk: payload.chunk, total: payload.total })
        return
      }

      if (isUnitSelectionMessage(payload)) {
        onUnitSelected?.(payload)
        return
      }

      onMessage?.(payload)
    })
  }, [isUnitInventoryMessage, isUnitSelectionMessage, onUnitInventory, onUnitSelected, onLevelLoaded, onUe5Init, onMessage])

  // ---------------------------------------------------------------------------
  // Vagon SDK mode — communicate via window.Vagon instead of raw WebSocket
  // ---------------------------------------------------------------------------
  // The Vagon SDK object (`window.Vagon`) may exist before the iframe stream
  // is fully initialised, meaning its methods (isConnected, onConnected, etc.)
  // might not yet be functions. We guard every call and retry until ready.
  // ---------------------------------------------------------------------------

  const isVagonReady = useCallback((): boolean => {
    const v = typeof window !== "undefined" ? window.Vagon : undefined
    return !!v && typeof v.onConnected === "function" && typeof v.sendApplicationMessage === "function"
  }, [])

  const connectVagon = useCallback(() => {
    if (!isVagonReady()) {
      console.warn("Vagon SDK not fully initialised yet, retrying in 1s...")
      const retryTimeout = setTimeout(() => connectVagon(), 1000)
      return () => clearTimeout(retryTimeout)
    }

    const vagon = window.Vagon!
    console.log("Using Vagon SDK for UE5 communication")

    // Listen for connection events
    vagon.onConnected(() => {
      console.log("Vagon: connected to UE5 stream")
      setState({ isConnected: true, isConnecting: false, error: null })
      onConnect?.()
    })

    vagon.onDisconnected(() => {
      console.log("Vagon: disconnected from UE5 stream")
      setState({ isConnected: false, isConnecting: false, error: null })
      onDisconnect?.()
    })

    // Listen for incoming messages from UE5
    vagon.onApplicationMessage(async (evt) => {
      const messages = await normalizeIncomingMessage(evt.message)
      handleIncomingPayloads(messages)
    })

    // Check if already connected (guard in case isConnected is not yet available)
    if (typeof vagon.isConnected === "function" && vagon.isConnected()) {
      setState({ isConnected: true, isConnecting: false, error: null })
      onConnect?.()
    } else {
      setState((prev) => ({ ...prev, isConnecting: true }))
    }

    return undefined
  }, [isVagonReady, onConnect, onDisconnect, normalizeIncomingMessage, handleIncomingPayloads])

  // ---------------------------------------------------------------------------
  // Direct WebSocket mode — local development
  // ---------------------------------------------------------------------------
  const connectWebSocket = useCallback(() => {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      return
    }

    setState((prev) => ({ ...prev, isConnecting: true, error: null }))

    try {
      const ws = new WebSocket(url)
      websocketRef.current = ws

      ws.onopen = () => {
        console.log(`Connected to UE5 WebSocket at ${url}`)
        setState({ isConnected: true, isConnecting: false, error: null })
        onConnect?.()
      }

      ws.onmessage = async (event) => {
        const messages = await normalizeIncomingMessage(event.data)
        handleIncomingPayloads(messages)
      }

      ws.onerror = (error) => {
        console.error("UE5 WebSocket error:", error)
        setState((prev) => ({ ...prev, error: "WebSocket connection error" }))
        onError?.(error)
      }

      ws.onclose = () => {
        console.log("UE5 WebSocket closed")
        setState({ isConnected: false, isConnecting: false, error: null })
        onDisconnect?.()
      }
    } catch (error) {
      console.error("Failed to create WebSocket:", error)
      setState({
        isConnected: false,
        isConnecting: false,
        error: (error as Error).message,
      })
    }
  }, [url, onConnect, onDisconnect, onError, normalizeIncomingMessage, handleIncomingPayloads])

  const connect = useCallback(() => {
    if (STREAM_MODE === "vagon") {
      connectVagon()
    } else {
      connectWebSocket()
    }
  }, [connectVagon, connectWebSocket])

  const disconnect = useCallback(() => {
    if (websocketRef.current) {
      websocketRef.current.close()
      websocketRef.current = null
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Send helpers — route through Vagon SDK or direct WebSocket
  // ---------------------------------------------------------------------------

  const sendViaVagon = useCallback((message: object): boolean => {
    const vagon = typeof window !== "undefined" ? window.Vagon : undefined
    if (!vagon || typeof vagon.sendApplicationMessage !== "function") {
      console.warn("Vagon SDK not ready, cannot send message")
      return false
    }

    const json = JSON.stringify(message)
    vagon.sendApplicationMessage(json)
    console.log("Sent to UE5 (via Vagon):", message)
    return true
  }, [])

  const sendViaWebSocket = useCallback((message: object): boolean => {
    if (!websocketRef.current || websocketRef.current.readyState !== WebSocket.OPEN) {
      console.warn("UE5 WebSocket not connected, cannot send message")
      return false
    }

    websocketRef.current.send(JSON.stringify(message))
    console.log("Sent to UE5:", message)
    return true
  }, [])

  const sendRawMessage = useCallback((message: object) => {
    if (STREAM_MODE === "vagon") {
      return sendViaVagon(message)
    }
    return sendViaWebSocket(message)
  }, [sendViaVagon, sendViaWebSocket])

  const sendMessage = useCallback((type: UE5MessageType | string, value?: unknown) => {
    const message = value !== undefined ? { type, value } : { type }
    return sendRawMessage(message)
  }, [sendRawMessage])

  // Convenience methods for common operations
  const sendStartTest = useCallback((hotelSlug: string) => {
    return sendRawMessage({ type: "startTEST", hotel: hotelSlug })
  }, [sendRawMessage])

  const sendHotelSelected = useCallback((hotelSlug: string) => {
    return sendRawMessage({ type: "hotelSelected", hotel: hotelSlug })
  }, [sendRawMessage])

  const sendGameEstate = useCallback((value: string) => {
    return sendMessage("gameEstate", value)
  }, [sendMessage])

  const sendSelectedRoom = useCallback((roomId: string) => {
    return sendMessage("selectedRoom", roomId)
  }, [sendMessage])

  const sendUnitView = useCallback((view: "interior" | "exterior") => {
    return sendMessage("unitView", view)
  }, [sendMessage])

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect()
    }

    return () => {
      disconnect()
    }
  }, [autoConnect, connect, disconnect])

  return {
    ...state,
    connect,
    disconnect,
    sendMessage,
    sendRawMessage,
    sendStartTest,
    sendHotelSelected,
    sendGameEstate,
    sendSelectedRoom,
    sendUnitView,
  }
}
