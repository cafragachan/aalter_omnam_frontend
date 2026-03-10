"use client"

import { useCallback, useEffect, useRef, useState } from "react"
// Types from lib/vagon.d.ts are picked up automatically by TypeScript

export type UE5MessageType =
  | "startTEST"
  | "gameEstate"
  | "selectedRoom"
  | "selectedAmenity"
  | "unitView"
  | "sunPosition"
  | "hotelSelected"
  | "profileUpdate"

export type UE5IncomingMessage = {
  type: string
  [key: string]: unknown
}

export type UnitSelectionMessage = {
  type: "unit"
  roomName: string
  description?: string
  price?: string
  level?: string
}

type UseUE5WebSocketOptions = {
  url?: string
  autoConnect?: boolean
  onMessage?: (message: UE5IncomingMessage) => void
  onUnitSelected?: (unit: UnitSelectionMessage) => void
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

  // ---------------------------------------------------------------------------
  // Vagon SDK message handler (shared with WebSocket path)
  // ---------------------------------------------------------------------------
  const handleIncomingPayloads = useCallback((messages: UE5IncomingMessage[]) => {
    messages.forEach((payload) => {
      console.log("Message from UE5:", payload)

      if (isUnitSelectionMessage(payload)) {
        onUnitSelected?.(payload)
        return
      }

      onMessage?.(payload)
    })
  }, [isUnitSelectionMessage, onUnitSelected, onMessage])

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
