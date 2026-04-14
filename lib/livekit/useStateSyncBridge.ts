"use client"

// Stage 5 of the HeyGen → LiveKit migration.
//
// Client-side state synchronization bridge. Watches journey/profile/hotel
// state + the EventBus and pushes data-channel messages to the agent per
// the State Synchronization Protocol in the migration plan:
//
//   - `state_snapshot` — fired when profile fields, selected hotel, or
//     journey stage change. Debounced to coalesce rapid profile updates.
//   - `ui_event` — fired immediately when the user does something visible
//     (tap a card, select a hotel, request back navigation). Mirrors every
//     EventBus event that has semantic value for the LLM.
//   - `narration_nudge` — the `onSpeak` callback returned from this hook.
//     Passed into useJourney as the `onSpeak` option so SPEAK effects
//     become LLM nudges instead of literal avatar speech.
//
// The hook is pure publisher — it never subscribes to agent → browser
// messages. Tool calls from the agent are handled by the sibling
// useToolCallBridge hook.
//
// SCOPE LOCK (Stage 5):
//   - Reads from useLiveKitAvatarContext (session ref), useUserProfileContext
//     (profile + journey stage), useApp (selectedHotel), and the lib/livekit
//     useUserProfile hook (derived profile from transcripts).
//   - Subscribes to the EventBus via useEventListener for every ui-facing
//     event type declared in lib/events.ts.
//   - Does not render anything.
//   - Does not dispatch journey actions.
//   - Safe to mount unconditionally on /home-v2 — all side effects are
//     no-ops when the room isn't connected yet.
//
// See lib/livekit/data-channel.ts for the DataChannelMessage union and
// the publishMessage/subscribeToMessages helpers.

import { useCallback, useEffect, useMemo, useRef } from "react"

import { useUserProfileContext, type UserProfile, type JourneyStage } from "@/lib/context"
import { useApp } from "@/lib/store"
import { useEventListener } from "@/lib/events"
import { getHotelBySlug } from "@/lib/hotel-data"
import type { JourneyState } from "@/lib/orchestrator/types"

import { useLiveKitAvatarContext } from "./context"
import { useUserProfile, type AvatarDerivedProfile } from "./useUserProfile"
import { publishMessage, type DataChannelMessage } from "./data-channel"
import type { Room } from "livekit-client"

// ---------------------------------------------------------------------
// Options + return shape
// ---------------------------------------------------------------------

type UseStateSyncBridgeOptions = {
  /**
   * When false, the bridge is a full no-op — `onSpeak` becomes a
   * no-op too and no data-channel messages are published. Stage 5
   * mounts the bridge unconditionally on /home-v2, so `enabled`
   * defaults to true and is rarely overridden; it exists so a future
   * pause-without-unmount flow can disable state sync cheaply.
   */
  enabled?: boolean

  /**
   * Optional getter for the journey reducer's internal state. When
   * provided, the state_snapshot payload includes an `awaiting` field
   * (PROFILE_COLLECTION's fine-grained sub-state) so the agent can tell
   * the LLM exactly which profile field to ask for next. Null-safe:
   * when undefined or returning null, `awaiting` is set to null.
   */
  getInternalState?: () => JourneyState | null
}

type UseStateSyncBridgeReturn = {
  /**
   * Pass to useJourney's `onSpeak` option. SPEAK effects become
   * narration_nudge data-channel messages instead of literal avatar
   * speech.
   */
  onSpeak: (text: string) => void
}

// ---------------------------------------------------------------------
// Debounce / dedup config
// ---------------------------------------------------------------------

const STATE_SNAPSHOT_DEBOUNCE_MS = 250

/**
 * Stage 6 Phase A — dedup window for ui_event and narration_nudge messages.
 * If the same event (by type+payload key) or the same nudge text fires
 * within this window, the duplicate is silently dropped. This prevents the
 * agent from being flooded when, e.g., UNIT_SELECTED_UE5 fires 10+ times
 * for a single user action.
 */
const DEDUP_WINDOW_MS = 500

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Serialize a Date to an ISO string or null. */
function toIsoOrNull(date: Date | null | undefined): string | null {
  if (!date) return null
  try {
    return date.toISOString()
  } catch {
    return null
  }
}

/**
 * Merge the global profile (UserProfileContext) with the derived
 * conversation profile (lib/livekit/useUserProfile) into a single flat
 * object for state_snapshot payloads. Derived values take precedence
 * for conversation-extracted fields; login-sourced fields come from the
 * global profile.
 */
function buildStateSnapshotPayload(args: {
  profile: UserProfile
  derivedProfile: AvatarDerivedProfile
  journeyStage: JourneyStage
  selectedHotelSlug: string | null
  internalState: JourneyState | null
}): Record<string, unknown> {
  const { profile, derivedProfile, journeyStage, selectedHotelSlug, internalState } = args
  const hotel = selectedHotelSlug ? getHotelBySlug(selectedHotelSlug) : null

  // partySize precedence: derived > familySize
  const partySize = derivedProfile.partySize ?? profile.familySize ?? null

  // Surface PROFILE_COLLECTION's fine-grained awaiting sub-state so the
  // agent's action guide knows exactly which field to ask for next.
  const awaiting =
    internalState && internalState.stage === "PROFILE_COLLECTION"
      ? internalState.awaiting
      : null

  return {
    stage: journeyStage,
    awaiting,
    profile: {
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      email: profile.email ?? null,
      partySize,
      guestComposition:
        derivedProfile.guestComposition ?? profile.guestComposition ?? null,
      destination: derivedProfile.destination ?? profile.destination ?? null,
      startDate: toIsoOrNull(derivedProfile.startDate ?? profile.startDate),
      endDate: toIsoOrNull(derivedProfile.endDate ?? profile.endDate),
      travelPurpose:
        derivedProfile.travelPurpose ?? profile.travelPurpose ?? null,
      interests:
        derivedProfile.interests.length > 0
          ? derivedProfile.interests
          : profile.interests,
      budgetRange: derivedProfile.budgetRange ?? profile.budgetRange ?? null,
      dietaryRestrictions:
        derivedProfile.dietaryRestrictions ?? profile.dietaryRestrictions ?? null,
      accessibilityNeeds:
        derivedProfile.accessibilityNeeds ?? profile.accessibilityNeeds ?? null,
      roomAllocation:
        derivedProfile.roomAllocation ?? profile.roomAllocation ?? null,
      distributionPreference:
        derivedProfile.distributionPreference ?? profile.distributionPreference ?? null,
      nationality: profile.nationality ?? derivedProfile.nationality ?? null,
      languagePreference: profile.languagePreference ?? null,
    },
    selectedHotel: hotel
      ? { slug: hotel.slug, name: hotel.name, location: hotel.location }
      : null,
  }
}

// ---------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------

export function useStateSyncBridge(
  options: UseStateSyncBridgeOptions = {},
): UseStateSyncBridgeReturn {
  const enabled = options.enabled ?? true
  const { getInternalState } = options

  const { sessionRef } = useLiveKitAvatarContext()
  const { profile, journeyStage } = useUserProfileContext()
  const { profile: derivedProfile } = useUserProfile()
  const { selectedHotel } = useApp()

  // Ref-wrap the getter so the memoized snapshot stays stable when callers
  // pass a fresh function identity each render. We re-read through the ref
  // on every snapshot rebuild.
  const getInternalStateRef = useRef(getInternalState)
  getInternalStateRef.current = getInternalState

  // Stable ref to the room so callback closures don't capture stale values.
  const roomRef = useRef<Room | null>(null)
  roomRef.current = sessionRef.current

  // Stable ref to the enabled flag so event listeners don't need to re-bind.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // --- Publish helper --------------------------------------------------
  // Fire-and-forget: publishMessage already guards against disconnect
  // and logs a warning on drop. We never await it — a slow publish must
  // not block the render loop.
  const publish = useCallback((msg: DataChannelMessage) => {
    if (!enabledRef.current) return
    const room = roomRef.current
    if (!room) return
    publishMessage(room, msg).catch((err) => {
      console.error("[state-sync] publish failed:", err)
    })
  }, [])

  // --- state_snapshot: debounced -----------------------------------------
  //
  // Profile extraction fires rapid updates as regex + AI results merge.
  // Coalesce them into one message per 250ms window so the agent's
  // chatCtx doesn't balloon. The debounce is trailing — we always
  // publish the latest snapshot, never an intermediate one.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSnapshotKeyRef = useRef<string>("")

  // Memoize the current snapshot so effect deps are stable on object identity.
  const currentSnapshot = useMemo(
    () =>
      buildStateSnapshotPayload({
        profile,
        derivedProfile,
        journeyStage,
        selectedHotelSlug: selectedHotel,
        internalState: getInternalStateRef.current?.() ?? null,
      }),
    [profile, derivedProfile, journeyStage, selectedHotel],
  )

  useEffect(() => {
    if (!enabled) return
    // Cheap dedupe — skip debounce if nothing actually changed.
    const snapshotKey = JSON.stringify(currentSnapshot)
    if (snapshotKey === lastSnapshotKeyRef.current) return

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      lastSnapshotKeyRef.current = snapshotKey
      publish({ type: "state_snapshot", payload: currentSnapshot })
      debounceTimerRef.current = null
    }, STATE_SNAPSHOT_DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [enabled, currentSnapshot, publish])

  // --- ui_event: immediate, one per EventBus event -----------------------
  //
  // Mirrors every OmnamEvent type declared in lib/events.ts that carries
  // meaning for the LLM. Internal-only events (FADE_TRANSITION, etc.)
  // are intentionally skipped because they are visual polish and would
  // just add noise to the chat context.
  //
  // Each handler publishes a `ui_event` data-channel message with a
  // human-readable `description` and the event's raw payload for
  // debugging/forwarding.
  //
  // Stage 6 Phase A: dedup guard. If the same event type + payload was
  // published within DEDUP_WINDOW_MS, the duplicate is silently dropped.
  // This prevents the 10+ duplicate UNIT_SELECTED_UE5 spam observed in
  // end-to-end testing.

  const lastUIEventRef = useRef<{ key: string; time: number }>({
    key: "",
    time: 0,
  })

  /**
   * Stage 6 Phase B Fix 3: per-event-TYPE rate limiting.
   *
   * The existing per-payload dedup (above) catches identical events within
   * 500ms, but doesn't handle rapid distinct-payload events of the same type
   * (e.g., tapping 5 different room cards in 2 seconds). This tracker
   * implements a "first + summary" pattern:
   *   - First 2 events of the same type go through immediately.
   *   - Subsequent events within 1s are buffered.
   *   - After 1s of quiet, a summary event fires with the count + last payload.
   */
  const eventTypeTrackerRef = useRef<
    Map<string, { count: number; timer: ReturnType<typeof setTimeout> | null; lastDescription: string; lastPayload: Record<string, unknown> | undefined }>
  >(new Map())

  /** Publish a ui_event with dedup + per-type rate limiting. */
  const publishUIEvent = useCallback(
    (
      eventName: string,
      description: string,
      payload?: Record<string, unknown>,
    ) => {
      // Phase A dedup: identical event within window
      const key = `${eventName}:${JSON.stringify(payload)}`
      const now = Date.now()
      if (
        key === lastUIEventRef.current.key &&
        now - lastUIEventRef.current.time < DEDUP_WINDOW_MS
      ) {
        return // dedup — same event within window
      }
      lastUIEventRef.current = { key, time: now }

      // Phase B: per-type rate limiting
      const trackerMap = eventTypeTrackerRef.current
      let tracker = trackerMap.get(eventName)
      if (!tracker) {
        tracker = { count: 0, timer: null, lastDescription: "", lastPayload: undefined }
        trackerMap.set(eventName, tracker)
      }

      tracker.count++
      tracker.lastDescription = description
      tracker.lastPayload = payload

      if (tracker.count <= 2) {
        // First two events go through immediately
        publish({
          type: "ui_event",
          event: eventName,
          description,
          payload,
        })
      }

      // Schedule a summary event after 1s of quiet
      if (tracker.timer) clearTimeout(tracker.timer)
      tracker.timer = setTimeout(() => {
        if (tracker!.count > 2) {
          publish({
            type: "ui_event",
            event: eventName,
            description: `User browsed ${tracker!.count} ${eventName} items, last: ${tracker!.lastDescription}`,
            payload: tracker!.lastPayload,
          })
        }
        // Reset tracker for next burst
        tracker!.count = 0
        tracker!.timer = null
      }, 1000)
    },
    [publish],
  )

  useEventListener("ROOM_CARD_TAPPED", (event) => {
    publishUIEvent(
      "ROOM_CARD_TAPPED",
      `User tapped the ${event.roomName} card (occupancy: ${event.occupancy}).`,
      {
        roomId: event.roomId,
        roomName: event.roomName,
        occupancy: event.occupancy,
      },
    )
  })

  useEventListener("AMENITY_CARD_TAPPED", (event) => {
    publishUIEvent(
      "AMENITY_CARD_TAPPED",
      `User tapped the ${event.name} amenity.`,
      {
        amenityId: event.amenityId,
        name: event.name,
        scene: event.scene,
      },
    )
  })

  useEventListener("UNIT_SELECTED_UE5", (event) => {
    publishUIEvent(
      "UNIT_SELECTED_UE5",
      `User selected ${event.roomName} in the 3D environment.`,
      {
        roomName: event.roomName,
        description: event.description ?? null,
        price: event.price ?? null,
        level: event.level ?? null,
      },
    )
  })

  useEventListener("HOTEL_SELECTED", (event) => {
    const hotel = getHotelBySlug(event.slug)
    const hotelName = hotel?.name ?? event.slug
    publishUIEvent("HOTEL_SELECTED", `User selected ${hotelName}.`, {
      slug: event.slug,
      name: hotel?.name ?? null,
      location: hotel?.location ?? null,
    })
  })

  useEventListener("PANEL_REQUESTED", (event) => {
    publishUIEvent(
      "PANEL_REQUESTED",
      `User requested the ${event.panel} panel.`,
      { panel: event.panel },
    )
  })

  useEventListener("VIEW_CHANGE", (event) => {
    publishUIEvent(
      "VIEW_CHANGE",
      `User switched to the ${event.view} view.`,
      { view: event.view },
    )
  })

  useEventListener("NAVIGATE_BACK", () => {
    publishUIEvent(
      "NAVIGATE_BACK",
      "User requested back navigation.",
    )
  })

  // FADE_TRANSITION is intentionally NOT mirrored — it's a visual polish
  // event with no semantic value to the LLM. Mirroring it would just
  // fill the chat context with noise.

  // --- onSpeak: narration_nudge translation ------------------------------
  //
  // useJourney's SPEAK effects carry literal, imperative text ("Welcome
  // to EDITION Lake Como, let me show you the rooms"). We forward the
  // text verbatim as `guidance` at priority "next_turn" — the LLM
  // weaves it into its next natural turn. Stage 6 may rewrite some of
  // these literal strings into directive guidance for better feel, but
  // the mechanical wiring is unchanged.
  //
  // The callback is stable (it closes over `publish`, which is also
  // stable) so useJourney's SPEAK executor deps don't re-fire on every
  // render.
  // Stage 6 Phase A: dedup guard for narration_nudge. The journey machine
  // may dispatch the same SPEAK text multiple times when the underlying
  // action fires repeatedly (e.g., unit selection spam → multiple SPEAK
  // effects with the same guidance text).
  const lastNudgeRef = useRef<{ text: string; time: number }>({
    text: "",
    time: 0,
  })

  const onSpeak = useCallback(
    (text: string) => {
      if (!enabledRef.current) return
      const now = Date.now()
      if (
        text === lastNudgeRef.current.text &&
        now - lastNudgeRef.current.time < DEDUP_WINDOW_MS
      ) {
        return // dedup — same nudge within window
      }
      lastNudgeRef.current = { text, time: now }
      publish({
        type: "narration_nudge",
        intent: "JOURNEY_SPEAK",
        guidance: text,
        priority: "interrupt",
      })
    },
    [publish],
  )

  return { onSpeak }
}
