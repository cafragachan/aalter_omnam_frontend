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
// non-200): logs `[ROOM_PLANNER_ERROR]` and silently returns (no fallback
// speech — see the comment in the error branch).
//
// Staleness: each call aborts the previous in-flight fetch so a slow
// response from an older turn cannot clobber a newer plan or speak over
// the latest turn's utterance.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { useOmnamStore, type CurrentRoomPlan } from "@/lib/omnam-store"
import { useLiveAvatarContext } from "@/lib/liveavatar/context"
import { MessageSender } from "@/lib/liveavatar/types"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"

type Trigger = "panel_opened" | "user_message"

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

  // Staleness guard: aborting the previous controller on each new call
  // terminates any in-flight fetch so slow older responses can't overwrite
  // a newer plan or speak over the current turn. Mirrors the pattern used
  // by `unifiedTurnAbortRef` in useJourney.ts.
  const abortRef = useRef<AbortController | null>(null)

  // Abort any pending request when the hook unmounts so orphan fetches
  // don't keep the roundtrip alive.
  useEffect(() => {
    return () => {
      const controller = abortRef.current
      if (controller && !controller.signal.aborted) {
        controller.abort()
      }
      abortRef.current = null
    }
  }, [])

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

      // Abort any previous in-flight planner call so a slow stale response
      // cannot overwrite a newer plan.
      const previous = abortRef.current
      if (previous && !previous.signal.aborted) {
        console.log("[ROOM_PLANNER_ABORT]", JSON.stringify({ reason: "new-call", trigger }))
        previous.abort()
      }
      const controller = new AbortController()
      abortRef.current = controller

      setIsPlanning(true)
      try {
        const res = await fetch("/api/room-planner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
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
          // Deliberately do NOT speak the FALLBACK line here. The reducer
          // already played the LLM-authored "pulling up the rooms" speech
          // on the triggering turn; following it up with "Sorry, I had
          // trouble..." double-speaks and mid-sentence-interrupts the
          // first utterance (see "competing with itself" symptom). The
          // rooms panel remains visible with its prior plan — user can
          // ask again if the state looks stale. Error is logged for
          // diagnostics either way.
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
        // Always close the planner utterance with the unit-picker hint so the
        // guest knows the UE5 scene is now interactive. Append defensively —
        // the LLM shouldn't emit this phrase, but guard against duplication
        // if it ever does.
        const HINT = "Please click on one of the available highlighted green units displayed."
        const base = data.speech.trim()
        const alreadyHinted = /highlighted\s+green\s+unit/i.test(base)
        const withHint = alreadyHinted
          ? base
          : `${base}${/[.!?]$/.test(base) ? "" : "."} ${HINT}`
        void repeat(withHint).catch(() => undefined)
      } catch (err) {
        // AbortController-triggered termination: a newer requestPlan call
        // superseded this one (or the component unmounted). Silently return
        // — no speech, no fallback, no error log beyond the abort trace
        // emitted when we kicked off the new call.
        if (
          (err instanceof DOMException && err.name === "AbortError") ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return
        }
        console.error("[ROOM_PLANNER_ERROR]", JSON.stringify({
          trigger,
          hotelSlug,
          error: (err as Error).message,
        }))
        // See note in the !res.ok branch above — do not speak on error.
      } finally {
        // Clear the ref only if it still points at our controller (a newer
        // requestPlan may have replaced it). Reset isPlanning only when this
        // call is the current one — otherwise the newer call already set it
        // true and will clear it on its own terminate.
        if (abortRef.current === controller) {
          abortRef.current = null
          setIsPlanning(false)
        }
      }
    },
    [dispatch, stateRef, interrupt, repeat],
  )

  return { requestPlan, isPlanning }
}
