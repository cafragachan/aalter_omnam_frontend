"use client"

// ---------------------------------------------------------------------------
// useRoomPlanner — Phase 1
//
// Thin client hook that wires the rooms panel to `/api/room-planner`.
// Triggered in two places:
//   (1) app/home/page.tsx — when `showRoomsPanel` transitions false → true.
//   (2) lib/orchestrator/useJourney.ts — when the orchestrate LLM returns a
//       room-edit intent AND the rooms panel is currently open.
//
// On success: dispatches `SET_ROOM_PLAN` into the OmnamStore and speaks the
// LLM-provided line via interrupt() + repeat(). On failure (network/timeout/
// non-200): speaks a warm fallback, does NOT touch the store, logs
// `[ROOM_PLANNER_ERROR]`.
// ---------------------------------------------------------------------------

import { useCallback, useRef, useState } from "react"
import { useOmnamStore, type CurrentRoomPlan } from "@/lib/omnam-store"
import { useLiveAvatarContext } from "@/lib/liveavatar/context"
import { MessageSender } from "@/lib/liveavatar/types"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"

type Trigger = "panel_opened" | "user_message"

const FALLBACK_SPEECH =
  "Sorry, I had trouble pulling up the rooms. Let me try again in a moment."

type RoomPlannerResponse = {
  plan: Array<{ roomId: string; quantity: number }>
  speech: string
  totalPerNight: number
  capacityOk: boolean
}

export function useRoomPlanner(): {
  requestPlan: (trigger: Trigger, latestMessage?: string) => Promise<void>
  isPlanning: boolean
} {
  const { state, stateRef, dispatch } = useOmnamStore()
  const { messages } = useLiveAvatarContext()
  const { interrupt, repeat } = useAvatarActions("FULL")

  // Live mirrors so the async requestPlan always reads the freshest values
  // without triggering re-renders or invalidating its useCallback identity.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const selectedHotelRef = useRef<string | null>(state.app.selectedHotel)
  selectedHotelRef.current = state.app.selectedHotel

  const [isPlanning, setIsPlanning] = useState(false)

  const requestPlan = useCallback(
    async (trigger: Trigger, latestMessage?: string): Promise<void> => {
      const snapshot = stateRef.current
      const hotelSlug = snapshot.app.selectedHotel
      if (!hotelSlug) {
        console.warn("[ROOM_PLANNER] requestPlan called with no selected hotel")
        return
      }

      // Read the last 40 user+avatar messages from LiveAvatarContext.
      const transcript = messagesRef.current
        .slice(-40)
        .map((m) => ({
          role: m.sender === MessageSender.AVATAR ? ("avatar" as const) : ("user" as const),
          text: m.message,
        }))

      const profile = snapshot.profile
      const body = {
        hotelSlug,
        profile: {
          partySize: profile.familySize ?? undefined,
          guestComposition: profile.guestComposition
            ? {
                adults: profile.guestComposition.adults,
                children: profile.guestComposition.children,
                childrenAges: profile.guestComposition.childrenAges,
              }
            : undefined,
          travelPurpose: profile.travelPurpose,
          startDate: profile.startDate
            ? profile.startDate.toISOString().slice(0, 10)
            : undefined,
          endDate: profile.endDate
            ? profile.endDate.toISOString().slice(0, 10)
            : undefined,
          budgetRange: profile.budgetRange,
          roomAllocation: profile.roomAllocation,
        },
        currentPlan: snapshot.currentRoomPlan
          ? snapshot.currentRoomPlan.rooms.map((r) => ({ roomId: r.roomId, quantity: r.quantity }))
          : null,
        transcript,
        trigger,
        latestMessage,
      }

      setIsPlanning(true)
      try {
        const res = await fetch("/api/room-planner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          let errBody: unknown = null
          try {
            errBody = await res.json()
          } catch {
            // non-JSON error body — keep null
          }
          console.error("[ROOM_PLANNER_ERROR]", JSON.stringify({
            status: res.status,
            trigger,
            hotelSlug,
            body: errBody,
          }))
          interrupt()
          void repeat(FALLBACK_SPEECH).catch(() => undefined)
          return
        }

        const data = (await res.json()) as RoomPlannerResponse
        // Build the store slice. `capacity` is derived the same way the server
        // computed it (sum of occupancy * quantity) — but we don't have room
        // occupancies on the client catalog in a guaranteed-complete shape,
        // so we persist the server's `capacityOk` decision and reconstruct
        // capacity to match `partySize` when capacityOk is true, else 0. The
        // store slice is not used for booking math — RoomsPanel only reads
        // `rooms` (plan entries) and `totalPerNight`.
        const partySize = snapshot.profile.familySize ?? 0
        const capacity = data.capacityOk ? Math.max(partySize, 0) : 0
        const nextPlan: CurrentRoomPlan = {
          rooms: data.plan,
          totalPerNight: data.totalPerNight,
          capacity,
        }

        dispatch({ type: "SET_ROOM_PLAN", plan: nextPlan })
        interrupt()
        void repeat(data.speech).catch(() => undefined)
      } catch (err) {
        console.error("[ROOM_PLANNER_ERROR]", JSON.stringify({
          trigger,
          hotelSlug,
          error: (err as Error).message,
        }))
        interrupt()
        void repeat(FALLBACK_SPEECH).catch(() => undefined)
      } finally {
        setIsPlanning(false)
      }
    },
    [dispatch, stateRef, interrupt, repeat],
  )

  return { requestPlan, isPlanning }
}
