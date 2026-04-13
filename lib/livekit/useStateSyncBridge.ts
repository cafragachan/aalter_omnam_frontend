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
// Debounce config
// ---------------------------------------------------------------------

const STATE_SNAPSHOT_DEBOUNCE_MS = 250

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
}): Record<string, unknown> {
  const { profile, derivedProfile, journeyStage, selectedHotelSlug } = args
  const hotel = selectedHotelSlug ? getHotelBySlug(selectedHotelSlug) : null

  // partySize precedence: derived > familySize
  const partySize = derivedProfile.partySize ?? profile.familySize ?? null

  return {
    stage: journeyStage,
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

  const { sessionRef } = useLiveKitAvatarContext()
  const { profile, journeyStage } = useUserProfileContext()
  const { profile: derivedProfile } = useUserProfile()
  const { selectedHotel } = useApp()

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

  useEventListener("ROOM_CARD_TAPPED", (event) => {
    publish({
      type: "ui_event",
      event: "ROOM_CARD_TAPPED",
      description: `User tapped the ${event.roomName} card (occupancy: ${event.occupancy}).`,
      payload: {
        roomId: event.roomId,
        roomName: event.roomName,
        occupancy: event.occupancy,
      },
    })
  })

  useEventListener("AMENITY_CARD_TAPPED", (event) => {
    publish({
      type: "ui_event",
      event: "AMENITY_CARD_TAPPED",
      description: `User tapped the ${event.name} amenity.`,
      payload: {
        amenityId: event.amenityId,
        name: event.name,
        scene: event.scene,
      },
    })
  })

  useEventListener("UNIT_SELECTED_UE5", (event) => {
    publish({
      type: "ui_event",
      event: "UNIT_SELECTED_UE5",
      description: `User selected ${event.roomName} in the 3D environment.`,
      payload: {
        roomName: event.roomName,
        description: event.description ?? null,
        price: event.price ?? null,
        level: event.level ?? null,
      },
    })
  })

  useEventListener("HOTEL_SELECTED", (event) => {
    const hotel = getHotelBySlug(event.slug)
    const hotelName = hotel?.name ?? event.slug
    publish({
      type: "ui_event",
      event: "HOTEL_SELECTED",
      description: `User selected ${hotelName}.`,
      payload: {
        slug: event.slug,
        name: hotel?.name ?? null,
        location: hotel?.location ?? null,
      },
    })
  })

  useEventListener("PANEL_REQUESTED", (event) => {
    publish({
      type: "ui_event",
      event: "PANEL_REQUESTED",
      description: `User requested the ${event.panel} panel.`,
      payload: { panel: event.panel },
    })
  })

  useEventListener("VIEW_CHANGE", (event) => {
    publish({
      type: "ui_event",
      event: "VIEW_CHANGE",
      description: `User switched to the ${event.view} view.`,
      payload: { view: event.view },
    })
  })

  useEventListener("NAVIGATE_BACK", () => {
    publish({
      type: "ui_event",
      event: "NAVIGATE_BACK",
      description: "User requested back navigation.",
    })
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
  const onSpeak = useCallback(
    (text: string) => {
      if (!enabledRef.current) return
      publish({
        type: "narration_nudge",
        intent: "JOURNEY_SPEAK",
        guidance: text,
        priority: "next_turn",
      })
    },
    [publish],
  )

  return { onSpeak }
}
