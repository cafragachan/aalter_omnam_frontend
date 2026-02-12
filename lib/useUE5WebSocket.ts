"use client"

import { useCallback, useEffect, useRef, useState } from "react"

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

  const connect = useCallback(() => {
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

        messages.forEach((payload) => {
          console.log("Message from UE5:", payload)

          if (isUnitSelectionMessage(payload)) {
            onUnitSelected?.(payload)
            return
          }

          onMessage?.(payload)
        })
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
  }, [url, onConnect, onDisconnect, onError, onMessage, onUnitSelected, normalizeIncomingMessage, isUnitSelectionMessage])

  const disconnect = useCallback(() => {
    if (websocketRef.current) {
      websocketRef.current.close()
      websocketRef.current = null
    }
  }, [])

  const sendMessage = useCallback((type: UE5MessageType | string, value?: unknown) => {
    if (!websocketRef.current || websocketRef.current.readyState !== WebSocket.OPEN) {
      console.warn("UE5 WebSocket not connected, cannot send message")
      return false
    }

    const message = value !== undefined ? { type, value } : { type }
    websocketRef.current.send(JSON.stringify(message))
    console.log("Sent to UE5:", message)
    return true
  }, [])

  const sendRawMessage = useCallback((message: object) => {
    if (!websocketRef.current || websocketRef.current.readyState !== WebSocket.OPEN) {
      console.warn("UE5 WebSocket not connected, cannot send message")
      return false
    }

    websocketRef.current.send(JSON.stringify(message))
    console.log("Sent to UE5:", message)
    return true
  }, [])

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
