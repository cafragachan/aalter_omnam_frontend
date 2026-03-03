"use client"

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react"
import React from "react"

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

export type OmnamEvent =
  | { type: "ROOM_CARD_TAPPED"; roomId: string; roomName: string; occupancy: string }
  | { type: "UNIT_SELECTED_UE5"; roomName: string; description?: string; price?: string; level?: string }
  | { type: "AMENITY_CARD_TAPPED"; amenityId: string; name: string; scene: string }
  | { type: "PANEL_REQUESTED"; panel: "rooms" | "amenities" | "location" }
  | { type: "NAVIGATE_BACK" }
  | { type: "VIEW_CHANGE"; view: "interior" | "exterior" }
  | { type: "HOTEL_SELECTED"; slug: string }
  | { type: "FADE_TRANSITION" }

// ---------------------------------------------------------------------------
// EventBus implementation
// ---------------------------------------------------------------------------

type Listener<T extends OmnamEvent = OmnamEvent> = (event: T) => void

export class EventBus {
  private listeners = new Map<string, Set<Listener<never>>>()

  on<T extends OmnamEvent["type"]>(
    type: T,
    listener: Listener<Extract<OmnamEvent, { type: T }>>,
  ) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(listener as Listener<never>)
    return () => this.off(type, listener)
  }

  off<T extends OmnamEvent["type"]>(
    type: T,
    listener: Listener<Extract<OmnamEvent, { type: T }>>,
  ) {
    this.listeners.get(type)?.delete(listener as Listener<never>)
  }

  emit<T extends OmnamEvent>(event: T) {
    const typeListeners = this.listeners.get(event.type)
    if (typeListeners) {
      typeListeners.forEach((listener) => (listener as Listener<T>)(event))
    }
  }
}

// ---------------------------------------------------------------------------
// React Context + Hook
// ---------------------------------------------------------------------------

const EventBusContext = createContext<EventBus | null>(null)

export function EventBusProvider({ children }: { children: ReactNode }) {
  const busRef = useRef<EventBus | null>(null)
  if (!busRef.current) {
    busRef.current = new EventBus()
  }

  return React.createElement(
    EventBusContext.Provider,
    { value: busRef.current },
    children,
  )
}

export function useEventBus() {
  const bus = useContext(EventBusContext)
  if (!bus) {
    throw new Error("useEventBus must be used within an EventBusProvider")
  }
  return bus
}

/** Subscribe to a specific event type. Automatically cleans up on unmount. */
export function useEventListener<T extends OmnamEvent["type"]>(
  type: T,
  handler: Listener<Extract<OmnamEvent, { type: T }>>,
) {
  const bus = useEventBus()
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const wrapper: Listener<Extract<OmnamEvent, { type: T }>> = (event) =>
      handlerRef.current(event)
    return bus.on(type, wrapper)
  }, [bus, type])
}

/** Emit helper that returns a stable callback. */
export function useEmit() {
  const bus = useEventBus()
  return useCallback(<T extends OmnamEvent>(event: T) => bus.emit(event), [bus])
}
