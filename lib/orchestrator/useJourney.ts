"use client"

import { useCallback, useEffect, useRef } from "react"
import { useUserProfileContext } from "@/lib/context"
import { useOmnamStore } from "@/lib/omnam-store"
import { useAuth } from "@/lib/auth-context"
import { useUserProfile as useHeyGenUserProfile } from "@/lib/liveavatar"
import { useAvatarActions as useHeyGenAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useLiveAvatarContext as useHeyGenLiveAvatarContext } from "@/lib/liveavatar/context"
import { MessageSender } from "@/lib/liveavatar/types"
import { useGuestIntelligence } from "@/lib/guest-intelligence"
import { classifyIntent, type UserIntent } from "./intents"
import { orchestrateLLM } from "./orchestrateLLM"
import { buildAmenityNarrative, profileCollectionAwaiting } from "./journey-machine"
import { evaluateFastPath, CLIENT_CANNED_SPEECH, type ProfileAwaiting } from "./profileFastPath"
import { useIdleDetection } from "./idle-detection"
import type { JourneyState, JourneyAction, JourneyEffect, AmenityRef } from "./types"
import { renderSpeech } from "./speech-renderer"
import { logTurn, logEffect, type EffectEntry } from "@/lib/debug"
import {
  getRecommendedAmenity,
  matchRoomByName,
  type Amenity,
  type HotelCatalog,
  type Room,
} from "@/lib/hotel-data"

// Aliases for amenity keywords the user might say that aren't literal amenity
// names. "Lounge" specifically maps to lobby inside the hotel — the only
// "lounge" we exit to is the *virtual* lounge, which is caught earlier by
// RETURN_TO_LOUNGE_RE (requires the literal word "virtual").
const AMENITY_ALIASES: Record<string, string> = {
  lounge: "lobby",
  reception: "lobby",
  entrance: "lobby",
}

// ---------------------------------------------------------------------------
// Phase 1 shadow-compare helper.
//
// Compares a legacy-dispatched action against the server's TurnDecision
// envelope action. Loose type-level match only: USER_INTENT vs USER_INTENT
// with the same `intent` string, ROOM_PLAN_ACTION with the same `action`
// string, PROFILE_TURN_RESULT with the same `decision`, NO_ACTION.
// No behavior change — just logs so Phase 3 can measure parity.
// ---------------------------------------------------------------------------
type LegacyDispatched =
  | { type: "USER_INTENT"; intent: string }
  | { type: "ROOM_PLAN_ACTION"; action: string }
  | { type: "PROFILE_TURN_RESULT"; decision: string }
  | { type: "FORCE_ADVANCE" }
  | { type: "NO_ACTION" }
  | { type: "SPEAK_ONLY" }

function decisionsMatch(
  legacy: LegacyDispatched,
  envelope: import("./types").TurnDecisionAction,
): boolean {
  if (envelope === null) return legacy.type === "NO_ACTION" || legacy.type === "SPEAK_ONLY"
  if (envelope.type === "USER_INTENT" && legacy.type === "USER_INTENT") {
    // envelope.intent is the wire string (e.g., "TRAVEL_TO_HOTEL") — compare
    // directly to the legacy intent tag.
    return envelope.intent === legacy.intent
  }
  if (envelope.type === "ROOM_PLAN_ACTION" && legacy.type === "ROOM_PLAN_ACTION") {
    return envelope.action === legacy.action
  }
  if (envelope.type === "PROFILE_TURN_RESULT" && legacy.type === "PROFILE_TURN_RESULT") {
    return envelope.decision === legacy.decision
  }
  if (envelope.type === "NO_ACTION") {
    return legacy.type === "NO_ACTION" || legacy.type === "SPEAK_ONLY"
  }
  return false
}

function logDecisionCompare(
  legacyAction: LegacyDispatched,
  envelope: import("./types").TurnDecision | undefined,
): void {
  if (!envelope) return
  // eslint-disable-next-line no-console
  console.log("[DECISION-COMPARE]", {
    legacyAction,
    envelopeAction: envelope.action,
    match: decisionsMatch(legacyAction, envelope.action),
    speech: envelope.speech,
  })
}

// ---------------------------------------------------------------------------
// Phase 6 — stateRef shim.
//
// Pre-Phase-6 useJourney held a private `stateRef = useRef<JourneyState>(...)`
// and mutated it imperatively (`stateRef.current = {...}`) from multiple call
// sites. Phase 6 moved JourneyState into the unified OmnamStore. To avoid
// rewriting every read/write in useJourney we return a proxy object that
// looks like a React ref but:
//   • reads go through the store's live mirror (`omnamStore.stateRef.current.journey`)
//   • writes dispatch a `JOURNEY_STATE_OVERRIDE` action so React, the store's
//     mirror, and any observers stay consistent.
//
// Consumers continue to see a `{current: JourneyState}` object.
// ---------------------------------------------------------------------------
function useJourneyStateRef(omnamStore: ReturnType<typeof useOmnamStore>): {
  current: JourneyState
} {
  // Stable across renders — the proxy closes over the store context, which is
  // itself stable for the Provider's lifetime (dispatch is memoized, stateRef
  // is a stable useRef object).
  const proxyRef = useRef<{ current: JourneyState } | null>(null)
  if (!proxyRef.current) {
    proxyRef.current = Object.defineProperty({} as { current: JourneyState }, "current", {
      get() {
        return omnamStore.stateRef.current.journey
      },
      set(next: JourneyState) {
        omnamStore.dispatch({ type: "JOURNEY_STATE_OVERRIDE", state: next })
      },
      configurable: true,
      enumerable: true,
    }) as { current: JourneyState }
  }
  return proxyRef.current
}

// ---------------------------------------------------------------------------
// useJourney — wires the pure state machine to React
// ---------------------------------------------------------------------------

type UseJourneyOptions = {
  onOpenPanel: (panel: "rooms" | "amenities" | "location") => void
  onClosePanels: () => void
  onUE5Command: (command: string, value: unknown) => void
  onResetToDefault: () => void
  onFadeTransition: () => void
  onSelectHotel: (slug: string) => void
  onUnitSelected?: (roomName: string) => void
  /** Callback to stop the HeyGen avatar session */
  onStopAvatar: () => void
  /** Callback to hide the UE5 stream iframe */
  onHideUE5Stream: () => void
  /** Amenities for the currently selected hotel (needed for voice-driven navigation) */
  amenities: Amenity[]
  /** Rooms for the currently selected hotel (needed for booking URL resolution) */
  rooms: Room[]
  /**
   * Phase 2: server-packed hotel catalog shipped with the session token.
   * Accepted but not yet used — Phase 3 plumbs this into the orchestrate
   * call so the tool schema (navigation intents + amenity names) can be
   * generated dynamically from a single authoritative source. The existing
   * `amenities` / `rooms` options remain the operative channel today.
   */
  catalog?: HotelCatalog | null
  /**
   * Phase 3 tri-state rollout flag.
   *   - "off"    — current regex-short-circuit behavior, no parallel orchestrate
   *                call on high-confidence intents. No [SHADOW] logging.
   *   - "shadow" — regex still dispatches as today, but every non-PROFILE_COLLECTION
   *                turn ALSO fires orchestrate in parallel. The response is compared
   *                with the regex-dispatched action via decisionsMatch() and logged
   *                under [SHADOW]. No user-visible behavior change.
   *   - "on"     — regex becomes a hint; decision_envelope.action drives dispatch.
   *                Envelope speech is the authoritative avatar line for the turn.
   *
   * Backward compat: accepts a legacy boolean too. `true` → "on", `false` → "off".
   * Phase 2.5's PROFILE_COLLECTION fast-path is always live regardless of this
   * flag; this tri-state governs the non-PROFILE_COLLECTION stages only.
   */
  useUnifiedOrchestrator?: "off" | "shadow" | "on" | boolean
  /**
   * Phase 2.5: when true, PROFILE_COLLECTION turns that advance the
   * regex-derived awaiting field to a fast-path-eligible value speak the
   * matching canned question immediately (via interrupt()+repeat()), while
   * the LLM call still runs in the background to validate extraction.
   * Default: true. Set to false (or NEXT_PUBLIC_PROFILE_FAST_PATH=false) for
   * instant rollback to the pure LLM path.
   */
  useProfileFastPath?: boolean
  /**
   * Phase 1 Room Planner: when provided, the orchestrate result handler
   * forwards room-edit intents to the dedicated `/api/room-planner` pipeline
   * while the rooms panel is visible. Passed as a ref so useJourney never
   * re-renders on planner identity changes.
   *
   * The companion `isRoomsPanelVisibleRef` gates the call — planner runs
   * only when the rooms panel is currently on screen.
   */
  requestRoomPlanRef?: {
    current: (
      trigger: "panel_opened" | "user_message",
      latestMessage?: string,
    ) => Promise<void>
  }
  isRoomsPanelVisibleRef?: { current: boolean }
}

export function useJourney(options: UseJourneyOptions) {
  const {
    onOpenPanel,
    onClosePanels,
    onUE5Command,
    onResetToDefault,
    onFadeTransition,
    onSelectHotel,
    amenities,
    rooms,
  } = options

  // Phase 2: accept the server-packed catalog. Stored in a ref so Phase 3
  // can pull the freshest value at orchestrate-call time without triggering
  // re-renders or changing any of this hook's existing control flow.
  const catalogRef = useRef<HotelCatalog | null>(options.catalog ?? null)
  useEffect(() => {
    catalogRef.current = options.catalog ?? null
  }, [options.catalog])

  // Phase 3 tri-state normalization.
  //
  // Priority order:
  //   1. Explicit tri-state string via options.useUnifiedOrchestrator
  //   2. Legacy boolean via options.useUnifiedOrchestrator (true → "on", false → "off")
  //   3. Default "off" for full backward-compat with callers that pass nothing.
  //
  // Consumers downstream can read either the tri-state (for the shadow-mode
  // branch) or the derived boolean `isUnifiedOn` (for the existing truthy
  // checks sprinkled through the file — fast-path gating, intent routing,
  // etc.). Keeping both avoids churn on dozens of unrelated code paths.
  const unifiedRaw = options.useUnifiedOrchestrator
  const useUnifiedOrchestratorMode: "off" | "shadow" | "on" =
    typeof unifiedRaw === "string"
      ? unifiedRaw
      : unifiedRaw === true
        ? "on"
        : "off"
  // Boolean view used by legacy branches: only "on" is treated as "unified on".
  // "shadow" leaves those non-PROFILE_COLLECTION legacy paths active (they
  // dispatch on regex) so the user-visible behavior is identical to "off" —
  // the only difference is the parallel orchestrate call and [SHADOW] logging
  // added below.
  const useUnifiedOrchestrator = useUnifiedOrchestratorMode === "on"
  // PROFILE_COLLECTION, per plan, is already unified through orchestrate in
  // both "shadow" and "on" — the tri-state flag governs only the
  // non-PROFILE_COLLECTION stages. This flag gates the fast-path and the
  // debounced orchestrate call inside the PROFILE_COLLECTION branch so that
  // flipping the outer tri-state doesn't accidentally disable profile
  // collection behavior that was already validated.
  const profileStageUsesOrchestrate = useUnifiedOrchestratorMode !== "off"
  // Phase 2.5: default ON. Caller passes false to disable.
  const useProfileFastPath = options.useProfileFastPath ?? true

  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const { userProfile: authIdentity, returningUserData } = useAuth()
  const { profile: derivedProfile, isExtractionPending, userMessages } = useHeyGenUserProfile()
  const { messages: allMessages } = useHeyGenLiveAvatarContext()
  const { repeat, interrupt, stopListening } = useHeyGenAvatarActions("FULL")
  const guestIntelligence = useGuestIntelligence()
  const { trackQuestion, trackRoomExplored, trackAmenityExplored, trackRequirement, startRoomTimer, startAmenityTimer, stopExplorationTimer, setBookingOutcome } = guestIntelligence

  // --- Phase 6: unified store ---
  // The internal JourneyState was previously held in a local ref (the third
  // source of truth in /home). It now lives in `OmnamStoreProvider.state.journey`.
  // `stateRef` keeps the SAME shape and API as before — a ref object with a
  // `.current` property — so the rest of this hook can read and write it
  // identically to the pre-Phase-6 code. Under the hood it delegates to the
  // store's live mirror via a proxy object:
  //   • reads (`stateRef.current`)         → pull from the store's mirror
  //   • writes (`stateRef.current = ...`)  → dispatch JOURNEY_STATE_OVERRIDE
  // so every access stays consistent with what React will commit.
  const omnamStore = useOmnamStore()
  const stateRef = useJourneyStateRef(omnamStore)
  // Phase 5: initialized lazily on the first effect tick so hydrated
  // messages (seeded via `LiveAvatarContextProvider.initialMessages`) do
  // not trigger phantom orchestrate dispatches on mount. `null` means
  // "first run — capture the current baseline and skip dispatch".
  const lastMessageCountRef = useRef<number | null>(null)
  const lastProfileKeyRef = useRef("")
  const destinationAnnouncedRef = useRef(false)
  const profileDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentRoomIdRef = useRef<string | null>(null)

  // --- Pre-generated speech ref (Phase 4: orchestrate fills this before processIntent) ---
  const preGeneratedSpeechRef = useRef<string | null>(null)

  // --- PROFILE_COLLECTION debounce + cancellation refs ---
  const profileMsgDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const profileOrchestrateCancelRef = useRef<(() => void) | null>(null)
  // Real fetch-level cancellation: aborting this controller terminates the
  // in-flight /api/orchestrate request so a stale response cannot speak over
  // a fast-path canned question or a newer turn's orchestrate result.
  const profileOrchestrateAbortRef = useRef<AbortController | null>(null)

  const abortStaleProfileOrchestrate = useCallback(
    (reason: "fast-path" | "new-turn" | "stage-change" | "unmount") => {
      const controller = profileOrchestrateAbortRef.current
      if (controller && !controller.signal.aborted) {
        // eslint-disable-next-line no-console
        console.log("[ORCHESTRATE-ABORT]", { reason })
        controller.abort()
      }
      profileOrchestrateAbortRef.current = null
    },
    [],
  )

  // --- Phase 2.5 fast-path state ---
  // Tracks the previous `profileCollectionAwaiting(...)` value so each user
  // turn can tell whether regex extraction made progress this turn.
  // Initial "dates_and_guests" matches INITIAL_JOURNEY_STATE.awaiting.
  const prevAwaitingRef = useRef<ProfileAwaiting>("dates_and_guests")
  // Flag set when fast-path fired this turn. The orchestrate response handler
  // reads this, applies profileUpdates silently, and suppresses its speech.
  const fastPathFiredThisTurnRef = useRef(false)
  // Diagnostic: total user turns observed (feeds the fast-path turnCount check).
  const profileTurnCountRef = useRef(0)

  // --- Live refs for profile / derivedProfile so the PROFILE_COLLECTION
  // setTimeout callback reads the FRESHEST values at fire time rather than
  // the closure snapshot from when it was scheduled. Critical because:
  //   • Effect re-runs short-circuit at the userMessages.length guard, so the
  //     already-scheduled timer's closure is never refreshed.
  //   • AI extraction (800ms debounce + HTTP) typically completes AFTER the
  //     orchestrate debounce was scheduled, so closure-captured derivedProfile
  //     missed the new aiProfile.
  // Updated via the useEffect below on every render.
  const profileRef = useRef(profile)
  const derivedProfileRef = useRef(derivedProfile)
  const isExtractionPendingRef = useRef(isExtractionPending)
  useEffect(() => {
    profileRef.current = profile
    derivedProfileRef.current = derivedProfile
    isExtractionPendingRef.current = isExtractionPending
  })

  // --- Admin: download all collected user data as JSON ---
  const downloadUserData = useCallback(async () => {
    const giSnapshot = guestIntelligence.getDataSnapshot()

    // Run AI analysis to infer personality traits + travel driver
    try {
      const res = await fetch("/api/analyze-guest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          guestIntelligence: giSnapshot,
          conversationMessages: userMessages,
        }),
      })
      if (res.ok) {
        const analysis = await res.json()
        if (analysis.personalityTraits) giSnapshot.personalityTraits = analysis.personalityTraits
        if (analysis.travelDriver) giSnapshot.travelDriver = analysis.travelDriver
      }
    } catch {
      // Graceful degradation — download without AI fields
    }

    const payload = {
      timestamp: new Date().toISOString(),
      profile,
      derivedProfile,
      guestIntelligence: giSnapshot,
      journeyStage,
      conversationMessages: userMessages,
    }

    const json = JSON.stringify(payload, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `omnam-guest-data-${profile.firstName ?? "guest"}-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [profile, derivedProfile, guestIntelligence, journeyStage, userMessages])

  // --- Apply profileUpdates from any orchestrate tool result ---
  //
  // Shared mapping: server `profileUpdates` (startDate / endDate as ISO
  // strings, partySize or guestComposition, travelPurpose, roomAllocation)
  // → UserProfile context updates. Idempotent. Logs [PROFILE_UPDATE→APPLY]
  // with the source tool so mid-conversation corrections are traceable.
  const applyOrchestrateProfileUpdates = useCallback((
    pu: Record<string, unknown> | null | undefined,
    source: "profile_turn" | "navigate_and_speak" | "no_action_speak" | "envelope",
  ) => {
    if (!pu || typeof pu !== "object" || Object.keys(pu).length === 0) return
    const updates: Partial<import("@/lib/context").UserProfile> = {}
    const startDate = pu.startDate
    const endDate = pu.endDate
    const partySize = pu.partySize
    const guestComposition = pu.guestComposition
    const travelPurpose = pu.travelPurpose
    const roomAllocation = pu.roomAllocation
    if (typeof startDate === "string") updates.startDate = new Date(startDate)
    if (typeof endDate === "string") updates.endDate = new Date(endDate)
    if (guestComposition && typeof guestComposition === "object") {
      const gc = guestComposition as { adults?: number; children?: number; childrenAges?: number[] }
      // UPDATE_PROFILE deep-merges guestComposition, so partial updates
      // (e.g. just childrenAges) preserve adults/children from prior state.
      updates.guestComposition = gc as import("@/lib/context").GuestComposition
      if (typeof gc.adults === "number" && typeof gc.children === "number") {
        updates.familySize = gc.adults + gc.children
      }
    } else if (typeof partySize === "number") {
      updates.familySize = partySize
    }
    if (typeof travelPurpose === "string") updates.travelPurpose = travelPurpose
    if (Array.isArray(roomAllocation)) updates.roomAllocation = roomAllocation as number[]
    if (Object.keys(updates).length > 0) {
      // eslint-disable-next-line no-console
      console.log("[PROFILE_UPDATE→APPLY]", JSON.stringify({
        source,
        llmProfileUpdates: pu,
        mappedToContextUpdates: {
          ...updates,
          startDate: updates.startDate?.toISOString?.() ?? undefined,
          endDate: updates.endDate?.toISOString?.() ?? undefined,
        },
      }))
      updateProfile(updates)
    }
  }, [updateProfile])

  // --- Phase 2 Room Planner: sole room brain when the rooms panel is open ---
  //
  // When the rooms panel is visible, the planner fires for EVERY user utterance
  // EXCEPT two classes of intent:
  //   • ROOM_EXIT_INTENT_TAGS — the user is leaving the rooms context entirely
  //     (end experience, return to lounge, switch to amenities/hotel overview,
  //     download data, travel elsewhere). The orchestrator/reducer handles
  //     these; the planner would only produce noise.
  //   • ROOM_INTERNAL_NAV_TAGS — the user is navigating inside the rooms UI
  //     (tap a card's interior/exterior, go back, book). These are room-card-
  //     detail gestures, not plan edits, and remain on the reducer path.
  //
  // All other intents (including UNKNOWN, ROOMS, ROOM_TOGETHER/SEPARATE,
  // ROOM_PLAN_CHEAPER/COMPACT, AMENITY_BY_NAME when panel is open, etc.) flow
  // to the planner. The planner reads the transcript and re-derives the plan
  // from conversation ground truth, so we no longer need an allow-list of
  // specific room-edit intents.
  const ROOM_EXIT_INTENT_TAGS = useRef(
    new Set<string>([
      "END_EXPERIENCE",
      "RETURN_TO_LOUNGE",
      "AMENITIES",
      "HOTEL_EXPLORE",
      "DOWNLOAD_DATA",
      "TRAVEL_TO_HOTEL",
    ]),
  )
  const ROOM_INTERNAL_NAV_TAGS = useRef(
    new Set<string>([
      "INTERIOR",
      "EXTERIOR",
      "BACK",
      "BOOK",
    ]),
  )
  const requestRoomPlanRef = options.requestRoomPlanRef
  const isRoomsPanelVisibleRef = options.isRoomsPanelVisibleRef
  const maybeKickRoomPlanner = useCallback(
    (intentTag: string, latestMessage: string) => {
      if (!requestRoomPlanRef?.current) return
      if (!isRoomsPanelVisibleRef?.current) return
      if (ROOM_EXIT_INTENT_TAGS.current.has(intentTag)) return
      if (ROOM_INTERNAL_NAV_TAGS.current.has(intentTag)) return
      void requestRoomPlanRef.current("user_message", latestMessage)
    },
    [requestRoomPlanRef, isRoomsPanelVisibleRef],
  )

  // --- Effect executor ---
  //
  // `source` explains where the effect list originated so the [EFFECT] log
  // can be traced back to the reducer, an orchestrate response, or an event
  // handler. Defaults to "reducer" (the dispatch path).
  const executeEffects = useCallback((
    effects: JourneyEffect[],
    source: EffectEntry["source"] = "reducer",
  ) => {
    for (const effect of effects) {
      // Log every effect before running it. Strip only the discriminant.
      const { type: _effectType, ...params } = effect as { type: string } & Record<string, unknown>
      // SPEAK_INTENT logs itself inside its case so it can attach `speechSource`.
      if (effect.type !== "SPEAK_INTENT") {
        logEffect({ type: effect.type, params: params as Record<string, unknown>, source })
      }
      switch (effect.type) {
        case "SPEAK_INTENT": {
          let text: string
          let speechSource: EffectEntry["speechSource"]
          if (preGeneratedSpeechRef.current !== null) {
            text = preGeneratedSpeechRef.current
            preGeneratedSpeechRef.current = null
            speechSource = "llm"
          } else {
            text = renderSpeech(effect.key, effect.args)
            speechSource = "rendered"
          }
          logEffect({
            type: effect.type,
            params: params as Record<string, unknown>,
            source,
            speechSource,
          })
          interrupt()
          repeat(text).catch(() => undefined)
          break
        }
        case "UE5_COMMAND":
          onUE5Command(effect.command, effect.value)
          break
        case "OPEN_PANEL":
          onOpenPanel(effect.panel)
          break
        case "CLOSE_PANELS":
          onClosePanels()
          break
        case "FADE_TRANSITION":
          onFadeTransition()
          break
        case "SET_JOURNEY_STAGE":
          setJourneyStage(effect.stage)
          break
        case "RESET_TO_DEFAULT":
          onResetToDefault()
          break
        case "DOWNLOAD_DATA":
          downloadUserData()
          onUE5Command("downloadData", "downloadData")
          break
        case "SELECT_HOTEL":
          onSelectHotel(effect.slug)
          break
        case "STOP_LISTENING":
          stopListening()
          break
        case "OPEN_BOOKING_URL": {
          const roomId = currentRoomIdRef.current
          if (roomId) {
            const room = rooms.find((r) => r.id === roomId)
            if (room?.book_url) {
              window.open(room.book_url, "_blank", "noopener,noreferrer")
              setBookingOutcome("booked")
            }
          }
          break
        }
        case "STOP_AVATAR":
          // Delay to let the farewell speech finish before stopping the session
          setTimeout(() => options.onStopAvatar(), 4000)
          break
        case "HIDE_UE5_STREAM":
          options.onHideUE5Stream()
          break
      }
    }
  }, [interrupt, repeat, stopListening, onUE5Command, onOpenPanel, onClosePanels, onFadeTransition, setJourneyStage, onResetToDefault, onSelectHotel, downloadUserData, rooms, setBookingOutcome, options])

  // --- Dispatch helper ---
  // Phase 6: delegate to the unified store. The store runs `journeyReducer`
  // internally and returns its effect list synchronously; we just feed those
  // to `executeEffects`. No local state mutation happens here anymore.
  const dispatch = useCallback((action: JourneyAction) => {
    const effects = omnamStore.dispatch(action)
    if (effects.length > 0) {
      executeEffects(effects, "reducer")
    }
  }, [executeEffects, omnamStore])

  // Expose the current internal JourneyState so outside observers
  // (e.g., useStateSyncBridge) can read the fine-grained substate.
  // Used by the state sync bridge to include `awaiting` in
  // state_snapshot payloads. Read-only for consumers.
  const getInternalState = useCallback(() => stateRef.current, [])

  // --- Amenity data helpers (compute data for rich actions dispatched to reducer) ---

  /** Build the lightweight AmenityRef[] the reducer needs from the full Amenity[] */
  const amenityRefs: AmenityRef[] = amenities.map((a) => ({ id: a.id, name: a.name, scene: a.scene }))

  /** Get visited amenity names from GuestIntelligence */
  const getVisitedAmenityNames = useCallback(
    () => guestIntelligence.data.amenitiesExplored.map((a) => a.name),
    [guestIntelligence.data.amenitiesExplored],
  )

  // --- Voice-driven amenity navigation (dispatches rich action to reducer) ---
  const navigateToAmenityByName = useCallback((amenityName: string) => {
    const normalized = AMENITY_ALIASES[amenityName.toLowerCase()] ?? amenityName.toLowerCase()
    const match = amenities.find((a) => {
      const n = a.name.toLowerCase()
      const s = a.scene.toLowerCase()
      return n.includes(normalized) || s.includes(normalized)
    })

    if (!match) {
      // No match — speak directly (no state change needed)
      const text = `I don't think we have a ${amenityName} at this property. Would you like to see the rooms, or explore the surrounding area?`
      interrupt()
      void repeat(text).catch(() => undefined)
      return
    }

    // Track this amenity visit + start timer
    trackAmenityExplored(match.name)
    startAmenityTimer(match.name)

    // Dispatch rich action — reducer handles UE5 commands, fade, speech, and state transition
    dispatch({
      type: "NAVIGATE_TO_AMENITY",
      amenity: { id: match.id, name: match.name, scene: match.scene },
      narrative: buildAmenityNarrative(match.name, match.scene),
      visitedAmenities: getVisitedAmenityNames(),
      allAmenities: amenityRefs,
    })
  }, [amenities, amenityRefs, trackAmenityExplored, startAmenityTimer, getVisitedAmenityNames, interrupt, repeat, dispatch])

  // Phase 3 shadow-mode helper ------------------------------------------------
  //
  // Fires a parallel orchestrate call for a non-PROFILE_COLLECTION turn WHOSE
  // DISPATCH ALREADY HAPPENED on the regex path. The response is only used to
  // compare with what we dispatched and emit a [SHADOW] log — no speech, no
  // state changes. This is the telemetry that Phase 3 rollout relies on to
  // validate that flipping to "on" won't regress behavior.
  //
  // The match field is derived from the existing decisionsMatch() helper
  // (Phase 1) so shadow and [DECISION-COMPARE] agree on what counts as a match.
  const fireShadowOrchestrate = useCallback(
    (
      latestMessage: string,
      currentState: JourneyState,
      stage: JourneyState["stage"],
      regexIntent: ReturnType<typeof classifyIntent>,
      legacy: LegacyDispatched,
    ) => {
      const isRoomContext = currentState.stage === "HOTEL_EXPLORATION" || currentState.stage === "ROOM_SELECTED"
      // Phase 4: always send the conversation transcript so the server can
      // reconstruct profile from ground truth. Same 80-message cap used by
      // the PROFILE_COLLECTION branch. Without this, shadow-mode orchestrate
      // calls see stale client state and mis-classify when the transcript
      // has newer info than context.
      const conversationHistory = allMessages
        .slice(-80)
        .map((m) => ({
          role: m.sender === MessageSender.AVATAR ? ("avatar" as const) : ("user" as const),
          text: m.message,
        }))
      ;(async () => {
        const result = await orchestrateLLM({
          message: latestMessage,
          state: currentState,
          guestFirstName: profile.firstName,
          travelPurpose: profile.travelPurpose ?? derivedProfile.travelPurpose,
          interests: profile.interests,
          rooms: isRoomContext
            ? rooms.map((r) => ({ id: r.id, name: r.name, occupancy: parseInt(r.occupancy, 10) || 2, price: r.price }))
            : undefined,
          partySize: (profile.familySize ?? derivedProfile.partySize) ?? undefined,
          budgetRange: profile.budgetRange ?? undefined,
          guestComposition: profile.guestComposition ?? derivedProfile.guestComposition ?? undefined,
          regexHint: regexIntent.type,
          conversationHistory,
        })
        if (!result) return
        const envelope = result.decision_envelope
        const dispatchedDesc =
          legacy.type === "USER_INTENT"
            ? `USER_INTENT:${legacy.intent}`
            : legacy.type === "ROOM_PLAN_ACTION"
              ? `ROOM_PLAN_ACTION:${legacy.action}`
              : legacy.type
        // eslint-disable-next-line no-console
        console.log("[SHADOW]", {
          stage,
          message: latestMessage.slice(0, 80),
          regexIntent: regexIntent.type,
          dispatched: dispatchedDesc,
          envelopeAction: envelope?.action?.type ?? (envelope === undefined ? "MISSING" : "NULL"),
          match: envelope ? decisionsMatch(legacy, envelope.action) : false,
          envelopeSpeech: envelope?.speech,
        })
        // Phase 9: even in shadow mode (where regex drives dispatch), apply
        // any mid-conversation profile correction the LLM attached. Writes
        // are idempotent; this is the sole write path post-extract-profile.
        applyOrchestrateProfileUpdates(
          (envelope as { profileUpdates?: Record<string, unknown> } | undefined)?.profileUpdates,
          "envelope",
        )
      })()
    },
    [profile, derivedProfile, rooms, allMessages, applyOrchestrateProfileUpdates],
  )

  /** Dispatch LIST_AMENITIES action with pre-computed hotel data */
  const dispatchListAmenities = useCallback(() => {
    const recommended = getRecommendedAmenity(amenities, profile.travelPurpose)
    dispatch({
      type: "LIST_AMENITIES",
      visitedAmenities: getVisitedAmenityNames(),
      allAmenities: amenityRefs,
      travelPurpose: profile.travelPurpose,
      recommendedAmenityName: recommended?.name,
    })
  }, [amenities, amenityRefs, profile.travelPurpose, getVisitedAmenityNames, dispatch])

  // --- Idle detection (re-engagement) ---
  const handleIdle = useCallback(() => {
    dispatch({ type: "IDLE_TIMEOUT" })
  }, [dispatch])

  useIdleDetection({
    journeyStage,
    onIdle: handleIdle,
  })

  // --- React to profile changes ---
  useEffect(() => {
    const profileKey = JSON.stringify({
      partySize: derivedProfile.partySize ?? profile.familySize,
      guestComposition: derivedProfile.guestComposition ?? profile.guestComposition,
      startDate: derivedProfile.startDate?.toISOString(),
      endDate: derivedProfile.endDate?.toISOString(),
      interests: derivedProfile.interests,
      travelPurpose: derivedProfile.travelPurpose ?? profile.travelPurpose,
      pending: isExtractionPending,
    })

    if (profileKey === lastProfileKeyRef.current) return
    lastProfileKeyRef.current = profileKey

    // Merge conversation-extracted profile with pre-seeded context values
    // so that returning-user defaults (e.g. guestComposition) are visible
    // to the journey machine even before the user explicitly restates them.
    const mergedProfile = {
      ...derivedProfile,
      partySize: derivedProfile.partySize ?? profile.familySize,
      guestComposition: derivedProfile.guestComposition ?? profile.guestComposition,
      travelPurpose: derivedProfile.travelPurpose ?? profile.travelPurpose,
      roomAllocation: derivedProfile.roomAllocation ?? profile.roomAllocation,
    }

    const doDispatch = () => {
      dispatch({
        type: "PROFILE_UPDATED",
        profile: mergedProfile,
        firstName: profile.firstName,
        isExtractionPending,
      })
    }

    // Debounce during PROFILE_COLLECTION so compound answers from
    // HeyGen's VAD splitting settle before evaluating profile completeness.
    //
    // Historical note: this block USED to also call
    // `profileOrchestrateCancelRef.current()` before dispatching, from back
    // when the reducer authored the next-question speech and a late-arriving
    // orchestrate answer could talk over it. That's no longer true — orchestrate
    // IS the speech authority during PROFILE_COLLECTION. Cancelling it here
    // silently muted any orchestrate call that ran longer than 2.5s (common
    // with gpt-4o), producing 20-40s avatar silences. The stage-transition
    // guard in the orchestrate response handler (~line 1114) is the correct
    // protection against stale responses; no cancel needed here.
    if (stateRef.current.stage === "PROFILE_COLLECTION") {
      if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
      profileDebounceRef.current = setTimeout(() => {
        doDispatch()
      }, 2500)
      return () => {
        if (profileDebounceRef.current) clearTimeout(profileDebounceRef.current)
      }
    }

    doDispatch()
  }, [derivedProfile, isExtractionPending, profile.firstName, profile.familySize, profile.guestComposition, profile.travelPurpose, profile.roomAllocation, dispatch])

  // --- processIntent: routes a classified intent through interception logic → dispatch ---
  // Extracted as a helper so both the sync (regex) and async (LLM) paths
  // share the same interception pipeline without duplication.
  const processIntent = useCallback((
    intent: ReturnType<typeof classifyIntent>,
    latestMessage: string,
    currentState: JourneyState,
    stage: JourneyState["stage"],
  ) => {
    // --- Exploration timer management ---
    if (stage === "ROOM_SELECTED" && (intent.type === "INTERIOR" || intent.type === "EXTERIOR")) {
      if (currentRoomIdRef.current) {
        startRoomTimer(currentRoomIdRef.current)
      }
    }

    if (
      (stage === "ROOM_SELECTED" || stage === "AMENITY_VIEWING") &&
      (intent.type === "BACK" || intent.type === "ROOMS" || intent.type === "LOCATION" || intent.type === "HOTEL_EXPLORE" || intent.type === "TRAVEL_TO_HOTEL")
    ) {
      stopExplorationTimer()
    }

    // --- Intercept amenity intents (need hotel data → dispatch rich actions) ---
    if (intent.type === "AMENITIES" || (intent.type === "OTHER_OPTIONS" && stage === "AMENITY_VIEWING")) {
      stopExplorationTimer()
      dispatchListAmenities()
      return
    }

    if (intent.type === "AMENITY_BY_NAME") {
      // Phase 2: when the rooms panel is open, "standard mountain view" and
      // similar room-ish phrases were previously mis-classified as
      // AMENITY_BY_NAME and would hijack navigation to the lobby. When the
      // planner is the sole room brain, swallow the intent and let the planner
      // interpret the utterance literally as a room request.
      if (isRoomsPanelVisibleRef?.current) return
      navigateToAmenityByName(intent.amenityName)
      return
    }

    // Bare "yes" → resolve against suggested amenity in state
    if (intent.type === "AFFIRMATIVE") {
      if (currentState.stage === "AMENITY_VIEWING" && currentState.suggestedNext) {
        navigateToAmenityByName(currentState.suggestedNext)
        return
      }
      if (currentState.stage === "HOTEL_EXPLORATION" && currentState.suggestedAmenityName) {
        navigateToAmenityByName(currentState.suggestedAmenityName)
        return
      }
    }

    // Default path — hand the intent to the reducer. Room-plan edits no longer
    // route through heuristic helpers here; the room planner (kicked from the
    // user-messages effect via maybeKickRoomPlanner) is the sole authority on
    // the displayed plan when the rooms panel is open.
    dispatch({ type: "USER_INTENT", intent })
  }, [dispatch, dispatchListAmenities, navigateToAmenityByName, startRoomTimer, stopExplorationTimer, isRoomsPanelVisibleRef])

  // --- React to new user messages (intent classification + question tracking) ---
  useEffect(() => {
    // Phase 5: on first run, baseline the ref to the hydrated message count
    // (if any). A refreshed session starts with N > 0 pre-existing messages;
    // we must NOT treat them as "new" turns and re-dispatch intents.
    if (lastMessageCountRef.current === null) {
      lastMessageCountRef.current = userMessages.length
      return
    }
    if (userMessages.length <= lastMessageCountRef.current) return
    lastMessageCountRef.current = userMessages.length

    const latestMessage = userMessages[userMessages.length - 1]?.message ?? ""

    // Track questions for GuestIntelligence
    if (latestMessage.includes("?")) {
      trackQuestion(latestMessage.trim())
    }

    // Track requirements for GuestIntelligence (runs at any stage)
    const REQUIREMENT_PATTERNS = [
      /\b(?:i need|i'd like|i would like|could you arrange|please arrange)\s+(.+?)(?:[.,!?]|$)/i,
      /\b(late\s+check.?out|early\s+check.?in)\b/i,
      /\b(allerg(?:y|ic)\s+to\s+.+?)(?:[.,!?]|$)/i,
      /\b(champagne|flowers|cake|surprise|celebration|anniversary|birthday)\b/i,
      /\b(crib|cot|baby\s+bed|extra\s+bed|rollaway|connecting\s+room|adjoining)\b/i,
      /\b(airport\s+transfer|airport\s+pickup|car\s+service)\b/i,
      /\b(feather.?free|hypoallergenic|firm\s+(?:mattress|pillow)|non.?smoking)\b/i,
      /\b(quiet\s+room|high(?:er)?\s+floor|away\s+from\s+(?:elevator|lift))\b/i,
    ]
    for (const pattern of REQUIREMENT_PATTERNS) {
      const match = latestMessage.match(pattern)
      if (match) {
        const requirement = (match[1] ?? match[0]).trim()
        if (requirement.length > 3 && requirement.length < 200) {
          trackRequirement(requirement)
        }
        break
      }
    }

    // --- Global intents — check before stage-specific routing ---
    const earlyIntent = classifyIntent(latestMessage)
    if (earlyIntent.type === "END_EXPERIENCE" || earlyIntent.type === "RETURN_TO_LOUNGE") {
      logTurn({
        stage: stateRef.current.stage,
        latestMessage: latestMessage.slice(-80),
        regexIntent: earlyIntent.type,
        llmIntent: null,
        action: { type: "USER_INTENT", intent: earlyIntent.type },
        speech: null,
        latencyMs: 0,
        pathway: "regex-shortcircuit",
      })
      dispatch({ type: "USER_INTENT", intent: earlyIntent })
      return
    }

    // --- END_CONFIRMING: intercept yes/no for farewell confirmation ---
    if (stateRef.current.stage === "END_CONFIRMING") {
      const confirmIntent = classifyIntent(latestMessage)
      if (confirmIntent.type === "AFFIRMATIVE" || confirmIntent.type === "NEGATIVE") {
        logTurn({
          stage: "END_CONFIRMING",
          latestMessage: latestMessage.slice(-80),
          regexIntent: confirmIntent.type,
          llmIntent: null,
          action: { type: "USER_INTENT", intent: confirmIntent.type },
          speech: null,
          latencyMs: 0,
          pathway: "regex-shortcircuit",
        })
        dispatch({ type: "USER_INTENT", intent: confirmIntent })
      }
      return
    }

    // --- LOUNGE_CONFIRMING: intercept yes/no for lounge return confirmation ---
    if (stateRef.current.stage === "LOUNGE_CONFIRMING") {
      const confirmIntent = classifyIntent(latestMessage)
      if (confirmIntent.type === "AFFIRMATIVE" || confirmIntent.type === "NEGATIVE") {
        logTurn({
          stage: "LOUNGE_CONFIRMING",
          latestMessage: latestMessage.slice(-80),
          regexIntent: confirmIntent.type,
          llmIntent: null,
          action: { type: "USER_INTENT", intent: confirmIntent.type },
          speech: null,
          latencyMs: 0,
          pathway: "regex-shortcircuit",
        })
        dispatch({ type: "USER_INTENT", intent: confirmIntent })
      }
      return
    }

    // Only classify intent when we're in a stage that cares about voice input
    const stage = stateRef.current.stage

    // PROFILE_COLLECTION: debounce so chunked VAD utterances settle into one
    // orchestrate call, then route everything through the LLM. Advance via
    // preGeneratedSpeechRef substitution so the reducer's hardcoded SPEAK
    // becomes the contextual transition speech.
    if (stage === "PROFILE_COLLECTION") {
      // --- Phase 2.5: fast-path ---------------------------------------------
      // Before scheduling the 700ms debounce, check whether the regex extractor
      // already advanced the awaiting state this turn. If it did, speak the
      // canned next-question IMMEDIATELY (interrupt + repeat). The LLM call
      // still runs in the background to refine extraction and log disagreements.
      //
      // Snapshots used:
      //   • prevAwaiting — the `awaiting` value BEFORE the current user
      //     utterance merged into derivedProfile. Kept in prevAwaitingRef,
      //     which is updated at the end of the fast-path evaluation (or at
      //     the end of the debounced callback) to the computed freshAwaiting.
      //   • freshAwaiting — re-derived here from the live refs so the regex's
      //     synchronous extraction of the just-arrived user message is visible.
      profileTurnCountRef.current += 1
      const fastPathTurnCount = profileTurnCountRef.current
      fastPathFiredThisTurnRef.current = false

      if (useProfileFastPath && profileStageUsesOrchestrate) {
        const liveProfileNow = profileRef.current
        const liveDerivedNow = derivedProfileRef.current
        const fastMergedProfile = {
          partySize: liveProfileNow.familySize ?? liveDerivedNow.partySize,
          startDate: liveDerivedNow.startDate ?? liveProfileNow.startDate,
          endDate: liveDerivedNow.endDate ?? liveProfileNow.endDate,
          travelPurpose: liveProfileNow.travelPurpose ?? liveDerivedNow.travelPurpose,
          interests: liveDerivedNow.interests,
          guestComposition: liveProfileNow.guestComposition ?? liveDerivedNow.guestComposition,
          roomAllocation: liveProfileNow.roomAllocation ?? liveDerivedNow.roomAllocation,
        }
        const fastFreshAwaiting = profileCollectionAwaiting(fastMergedProfile)
        const fastPathDecisionStart = Date.now()
        const fastPathDecision = evaluateFastPath({
          prevAwaiting: prevAwaitingRef.current,
          freshAwaiting: fastFreshAwaiting,
          latestMessage,
          turnCount: fastPathTurnCount,
        })

        if (fastPathDecision.eligible) {
          // Invariant: fastPathDecision.cannedSpeech === CLIENT_CANNED_SPEECH[freshAwaiting].
          // Reading CLIENT_CANNED_SPEECH here both documents the contract and keeps
          // the import load-bearing so accidental removal breaks the build.
          const expectedCanned = CLIENT_CANNED_SPEECH[fastPathDecision.nextAwaiting]
          if (expectedCanned !== fastPathDecision.cannedSpeech) {
            // eslint-disable-next-line no-console
            console.warn("[FAST_PATH_INVARIANT]", { expectedCanned, actual: fastPathDecision.cannedSpeech })
          }

          // Kill any orchestrate call still in flight from a prior turn. Its
          // response would otherwise land ~6s later and speak over the canned
          // question we're about to utter.
          abortStaleProfileOrchestrate("fast-path")

          // Speak the canned question immediately.
          interrupt()
          repeat(fastPathDecision.cannedSpeech).catch(() => undefined)

          // Apply whatever the regex already captured. updateProfile is a
          // Partial merge — idempotent with the later LLM writes.
          const regexUpdates: Partial<import("@/lib/context").UserProfile> = {}
          if (liveDerivedNow.startDate) regexUpdates.startDate = liveDerivedNow.startDate
          if (liveDerivedNow.endDate) regexUpdates.endDate = liveDerivedNow.endDate
          if (liveDerivedNow.partySize != null && !liveProfileNow.familySize) {
            regexUpdates.familySize = liveDerivedNow.partySize
          }
          if (liveDerivedNow.guestComposition && !liveProfileNow.guestComposition) {
            regexUpdates.guestComposition = liveDerivedNow.guestComposition
          }
          if (liveDerivedNow.travelPurpose && !liveProfileNow.travelPurpose) {
            regexUpdates.travelPurpose = liveDerivedNow.travelPurpose
          }
          if (liveDerivedNow.roomAllocation && !liveProfileNow.roomAllocation) {
            regexUpdates.roomAllocation = liveDerivedNow.roomAllocation
          }
          if (Object.keys(regexUpdates).length > 0) updateProfile(regexUpdates)

          fastPathFiredThisTurnRef.current = true
          prevAwaitingRef.current = fastFreshAwaiting

          logTurn({
            stage: "PROFILE_COLLECTION",
            latestMessage: latestMessage.slice(-80),
            regexIntent: null,
            llmIntent: null,
            action: { type: "PROFILE_TURN_RESULT", decision: "ask_next", awaiting: fastFreshAwaiting },
            speech: fastPathDecision.cannedSpeech,
            latencyMs: Date.now() - fastPathDecisionStart,
            pathway: "fast-path",
          })
          // Intentionally fall through — still schedule the background
          // orchestrate so profileUpdates from the LLM land idempotently.
        }
      }

      if (profileMsgDebounceRef.current) clearTimeout(profileMsgDebounceRef.current)
      profileMsgDebounceRef.current = setTimeout(() => {
        // Read the FRESHEST profile/derivedProfile via refs, not closure — the
        // closure snapshot is from scheduling time and misses AI extractions
        // that completed during the debounce window (AI extraction has its own
        // 800ms debounce + HTTP latency).
        const liveProfile = profileRef.current
        const liveDerivedProfile = derivedProfileRef.current

        // Prefer context values first because ProfileSync derives correct
        // composite fields (e.g., familySize = adults + children) while raw
        // regex partySize can miscount. Fall back to derivedProfile otherwise.
        const mergedProfile = {
          partySize: liveProfile.familySize ?? liveDerivedProfile.partySize,
          startDate: liveDerivedProfile.startDate ?? liveProfile.startDate,
          endDate: liveDerivedProfile.endDate ?? liveProfile.endDate,
          travelPurpose: liveProfile.travelPurpose ?? liveDerivedProfile.travelPurpose,
          interests: liveDerivedProfile.interests,
          guestComposition: liveProfile.guestComposition ?? liveDerivedProfile.guestComposition,
          roomAllocation: liveProfile.roomAllocation ?? liveDerivedProfile.roomAllocation,
        }
        const freshAwaiting = profileCollectionAwaiting(mergedProfile)
        // Snapshot whether the fast-path already spoke this turn (see above).
        // Kept in a local because the ref is per-turn and will be reset by the
        // next user utterance before this callback's await resolves.
        const fastPathAlreadySpoke = fastPathFiredThisTurnRef.current

        if (!profileStageUsesOrchestrate) {
          // Flag off entirely — update ref so next turn sees the current
          // awaiting and move on without calling orchestrate.
          prevAwaitingRef.current = freshAwaiting
          return
        }

        // Full transcript — the LLM is the only writer in PROFILE_COLLECTION
        // and the earlier slice(-10) caused it to forget fields the guest gave
        // on the first turn. Token cost is negligible for the short pre-hotel
        // chat. Cap generously at 80 messages as a runaway guard.
        const conversationHistory = allMessages
          .slice(-80)
          .map((m) => ({
            role: m.sender === MessageSender.AVATAR ? ("avatar" as const) : ("user" as const),
            text: m.message,
          }))

        let cancelled = false
        profileOrchestrateCancelRef.current = () => {
          cancelled = true
          profileOrchestrateCancelRef.current = null
        }

        // Real fetch-level cancellation. Abort whatever call is in flight from
        // a prior turn (fast-path's abort already handled the
        // `fastPathAlreadySpoke` case, but a non-fast-path turn that arrives
        // while an earlier orchestrate is still pending must also cancel it).
        abortStaleProfileOrchestrate("new-turn")
        const controller = new AbortController()
        profileOrchestrateAbortRef.current = controller

        console.log("[CLIENT→ORCHESTRATE]", JSON.stringify({
          liveProfile_familySize: liveProfile.familySize,
          liveProfile_guestComp: liveProfile.guestComposition,
          liveProfile_startDate: liveProfile.startDate?.toISOString?.() ?? null,
          liveProfile_endDate: liveProfile.endDate?.toISOString?.() ?? null,
          liveProfile_travelPurpose: liveProfile.travelPurpose,
          liveProfile_roomAlloc: liveProfile.roomAllocation,
          derivedProfile_partySize: liveDerivedProfile.partySize,
          derivedProfile_startDate: liveDerivedProfile.startDate?.toISOString?.() ?? null,
          derivedProfile_endDate: liveDerivedProfile.endDate?.toISOString?.() ?? null,
          mergedPartySize: mergedProfile.partySize,
          mergedStartDate: mergedProfile.startDate?.toISOString?.() ?? null,
          mergedEndDate: mergedProfile.endDate?.toISOString?.() ?? null,
          freshAwaiting,
        }))
        const profileOrchestrateStart = Date.now()
        const profileTurnMessageSlice = latestMessage.slice(-80)
        const profileRegexIntent = classifyIntent(latestMessage)
        ;(async () => {
          const result = await orchestrateLLM({
            message: latestMessage,
            state: stateRef.current,
            guestFirstName: liveProfile.firstName,
            travelPurpose: mergedProfile.travelPurpose,
            partySize: mergedProfile.partySize ?? undefined,
            guestComposition: mergedProfile.guestComposition ?? undefined,
            profileAwaiting: freshAwaiting,
            startDate: mergedProfile.startDate ? mergedProfile.startDate.toISOString().slice(0, 10) : undefined,
            endDate: mergedProfile.endDate ? mergedProfile.endDate.toISOString().slice(0, 10) : undefined,
            roomAllocation: mergedProfile.roomAllocation ?? undefined,
            identity: authIdentity,
            personality: returningUserData?.personality ?? null,
            preferences: returningUserData?.preferences ?? null,
            loyalty: returningUserData?.loyalty ?? null,
            conversationHistory,
            signal: controller.signal,
          })
          const profileLatencyMs = Date.now() - profileOrchestrateStart
          // Do NOT cancel here — profile state writes are idempotent and must
          // always land. Cancellation only applies to speech/dispatch below.
          profileOrchestrateCancelRef.current = null

          // If THIS call's controller was aborted (fast-path fired, a newer
          // turn superseded us, stage changed, or we're unmounting) — short
          // circuit entirely. No speech, no dispatch, no degraded-mode
          // fallback, no logTurn. Profile updates from the user's utterance
          // still landed via the regex extractor in useUserProfile.ts (which
          // ProfileSync writes to UserProfileContext independently of this
          // orchestrate roundtrip).
          if (controller.signal.aborted) return

          // Clear the ref only if it still points at our controller (a newer
          // turn may have already replaced it).
          if (profileOrchestrateAbortRef.current === controller) {
            profileOrchestrateAbortRef.current = null
          }

          // Guard: stage may have advanced while LLM was in-flight
          if (stateRef.current.stage !== "PROFILE_COLLECTION") return

          if (!result) {
            logTurn({
              stage: "PROFILE_COLLECTION",
              latestMessage: profileTurnMessageSlice,
              regexIntent: profileRegexIntent.type,
              llmIntent: null,
              action: { type: "PROFILE_DEGRADED", awaiting: freshAwaiting },
              speech: null,
              latencyMs: profileLatencyMs,
              pathway: "fallback",
            })
            // Degraded mode: LLM unavailable. Preserve advancement using regex + freshAwaiting.
            // No preGeneratedSpeechRef write — the reducer's hardcoded "Wonderful!..." is the
            // accepted degraded-mode speech.
            prevAwaitingRef.current = freshAwaiting
            if (cancelled) return
            const fallbackIntent = classifyIntent(latestMessage)
            if (
              !fastPathAlreadySpoke &&
              (freshAwaiting === "ready" ||
                fallbackIntent.type === "TRAVEL_TO_HOTEL" ||
                fallbackIntent.type === "AFFIRMATIVE")
            ) {
              dispatch({ type: "FORCE_ADVANCE" })
            }
            return
          }

          if (result.tool === "profile_turn") {
            logTurn({
              stage: "PROFILE_COLLECTION",
              latestMessage: profileTurnMessageSlice,
              regexIntent: profileRegexIntent.type,
              llmIntent: "PROFILE_TURN",
              action: { type: "PROFILE_TURN", decision: result.decision },
              speech: result.speech,
              latencyMs: profileLatencyMs,
              pathway: "orchestrate",
            })
            // Phase 2.5: if fast-path already spoke this turn and the LLM now
            // returns "clarify", log a disagreement for later review. v1 is
            // log-only — we do NOT correct the avatar.
            if (fastPathAlreadySpoke && result.decision === "clarify") {
              // eslint-disable-next-line no-console
              console.log("[FAST_PATH_DISAGREE]", {
                fastPathAwaiting: freshAwaiting,
                llmDecision: result.decision,
                llmSpeech: result.speech,
              })
            }
            // Apply LLM-extracted fields to the profile. The LLM is the source
            // of truth during PROFILE_COLLECTION. Apply happens UNCONDITIONALLY
            // — even if a newer user turn started an overlapping orchestrate
            // that set `cancelled=true`. Profile writes are idempotent; losing
            // them is what caused partySize/guestComposition to never persist
            // when the user spoke rapidly.
            const pu = result.profileUpdates
            const updates: Partial<import("@/lib/context").UserProfile> = {}
            if (pu.startDate) updates.startDate = new Date(pu.startDate)
            if (pu.endDate) updates.endDate = new Date(pu.endDate)
            if (pu.guestComposition) {
              updates.guestComposition = pu.guestComposition
              updates.familySize =
                pu.guestComposition.adults + pu.guestComposition.children
            } else if (pu.partySize != null) {
              updates.familySize = pu.partySize
            }
            if (pu.travelPurpose) updates.travelPurpose = pu.travelPurpose
            if (pu.roomAllocation) updates.roomAllocation = pu.roomAllocation
            console.log("[PROFILE_TURN→APPLY]", JSON.stringify({
              cancelled,
              llmProfileUpdates: pu,
              mappedToContextUpdates: {
                ...updates,
                startDate: updates.startDate?.toISOString?.() ?? undefined,
                endDate: updates.endDate?.toISOString?.() ?? undefined,
              },
            }))
            if (Object.keys(updates).length > 0) updateProfile(updates)

            // Phase 2.5: fast-path already spoke, so suppress LLM speech.
            // profileUpdates were applied just above (idempotent). If the LLM
            // still thinks we should advance (decision === "ready") while the
            // fast-path just asked another question, trust the fast-path: we
            // already promised the user we wanted another detail.
            if (fastPathAlreadySpoke) {
              prevAwaitingRef.current = freshAwaiting
              logDecisionCompare(
                { type: "PROFILE_TURN_RESULT", decision: result.decision },
                result.decision_envelope,
              )
              return
            }

            // Speech IS cancellable — if a newer turn is in flight, don't
            // step on it with stale dialogue.
            if (cancelled) return

            if (result.decision === "ready") {
              // Warm handoff — substitute the reducer's hardcoded advance speech.
              preGeneratedSpeechRef.current = result.speech
              dispatch({ type: "FORCE_ADVANCE" })
              prevAwaitingRef.current = freshAwaiting
              logDecisionCompare(
                { type: "PROFILE_TURN_RESULT", decision: result.decision },
                result.decision_envelope,
              )
              return
            }

            // ask_next or clarify — speak directly, stay in PROFILE_COLLECTION.
            interrupt()
            repeat(result.speech).catch(() => undefined)
            prevAwaitingRef.current = freshAwaiting
            logDecisionCompare(
              { type: "PROFILE_TURN_RESULT", decision: result.decision },
              result.decision_envelope,
            )
            return
          }

          // --- Legacy tool fallbacks (should not occur with the new prompt,
          // but kept defensively in case the model picks a different tool) ---

          if (
            result.tool === "navigate_and_speak" &&
            (result.intent.type === "TRAVEL_TO_HOTEL" || result.intent.type === "AFFIRMATIVE")
          ) {
            logTurn({
              stage: "PROFILE_COLLECTION",
              latestMessage: profileTurnMessageSlice,
              regexIntent: profileRegexIntent.type,
              llmIntent: result.intent.type,
              action: { type: "FORCE_ADVANCE" },
              speech: result.speech,
              latencyMs: profileLatencyMs,
              pathway: "orchestrate",
            })
            prevAwaitingRef.current = freshAwaiting
            // Phase 2.5: if fast-path already asked another question, do not
            // advance — the user still owes us an answer.
            if (fastPathAlreadySpoke) {
              logDecisionCompare(
                { type: "USER_INTENT", intent: result.intent.type },
                result.decision_envelope,
              )
              return
            }
            if (cancelled) return
            preGeneratedSpeechRef.current = result.speech
            dispatch({ type: "FORCE_ADVANCE" })
            logDecisionCompare(
              { type: "USER_INTENT", intent: result.intent.type },
              result.decision_envelope,
            )
            return
          }

          logTurn({
            stage: "PROFILE_COLLECTION",
            latestMessage: profileTurnMessageSlice,
            regexIntent: profileRegexIntent.type,
            llmIntent: result.tool,
            action: null,
            speech: result.speech,
            latencyMs: profileLatencyMs,
            pathway: "orchestrate",
          })
          prevAwaitingRef.current = freshAwaiting
          if (fastPathAlreadySpoke) {
            logDecisionCompare({ type: "SPEAK_ONLY" }, result.decision_envelope)
            return
          }
          if (cancelled) return
          interrupt()
          repeat(result.speech).catch(() => undefined)
          logDecisionCompare({ type: "SPEAK_ONLY" }, result.decision_envelope)
        })()
      }, 700)
      return
    }

    if (stage === "DESTINATION_SELECT") return

    // In the virtual lounge, skip budget/amenity interception — just dispatch intent directly.
    //
    // Phase 3:
    //   - "off"    — regex classifies and dispatches as before.
    //   - "shadow" — dispatch on regex (same as today) AND fire orchestrate in parallel,
    //                comparing via [SHADOW] log. No behavior change.
    //   - "on"     — let the main consolidated branch below handle this stage through
    //                orchestrate; fall through.
    if (stage === "VIRTUAL_LOUNGE" && useUnifiedOrchestratorMode !== "on") {
      const intent = classifyIntent(latestMessage)
      logTurn({
        stage,
        latestMessage: latestMessage.slice(-80),
        regexIntent: intent.type,
        llmIntent: null,
        action: { type: "USER_INTENT", intent: intent.type },
        speech: null,
        latencyMs: 0,
        pathway: "regex-shortcircuit",
      })
      dispatch({ type: "USER_INTENT", intent })
      if (useUnifiedOrchestratorMode === "shadow") {
        fireShadowOrchestrate(
          latestMessage,
          stateRef.current,
          stage,
          intent,
          { type: "USER_INTENT", intent: intent.type },
        )
      }
      return
    }

    const currentState = stateRef.current

    // --- Voice-driven room selection (before intent classification) ---
    // When the rooms panel is open, try to fuzzy-match the raw utterance
    // against available room names. This lets users say things like
    // "the mountain view", "show me the penthouse", "loft suite lake" etc.
    if (
      currentState.stage === "HOTEL_EXPLORATION" &&
      currentState.subState === "panel_open"
    ) {
      // Single room selection — fuzzy match room name.
      // Multi-room composition ("2 standard rooms and 1 loft") is handled by
      // the dedicated room planner (/api/room-planner), kicked from
      // `maybeKickRoomPlanner` below. This fuzzy match only routes to a
      // specific room card; anything else falls through to the planner.
      const matched = matchRoomByName(latestMessage, rooms)
      if (matched) {
        onRoomCardTappedRef.current({
          roomId: matched.id,
          roomName: matched.name,
          occupancy: matched.occupancy,
        })
        return
      }
      // No match — fall through to normal intent classification
      // (the user might be saying "go back", "show amenities", etc.)
    }

    const regexIntent = classifyIntent(latestMessage)
    const turnMessageSlice = latestMessage.slice(-80)

    // --- Phase 3: shadow mode ---
    //
    // Dispatch on regex as before, then fire orchestrate in parallel so we can
    // log [SHADOW] comparisons. No user-visible behavior change — this is pure
    // telemetry to validate that flipping the flag to "on" won't regress.
    if (useUnifiedOrchestratorMode === "shadow") {
      logTurn({
        stage,
        latestMessage: turnMessageSlice,
        regexIntent: regexIntent.type,
        llmIntent: null,
        action: { type: "USER_INTENT", intent: regexIntent.type },
        speech: null,
        latencyMs: 0,
        pathway: "regex-shortcircuit",
      })
      processIntent(regexIntent, latestMessage, currentState, stage)
      // Phase 1 Room Planner: trigger 2 is flag-agnostic — room-edit intents
      // while the panel is open should route to the planner regardless of
      // shadow vs on mode. Kicks after processIntent so SET_ROOM_PLAN lands
      // after any legacy-path UI mutations.
      maybeKickRoomPlanner(regexIntent.type, latestMessage)
      fireShadowOrchestrate(
        latestMessage,
        currentState,
        stage,
        regexIntent,
        { type: "USER_INTENT", intent: regexIntent.type },
      )
      return
    }

    // --- Phase 3: consolidated orchestrate branch ("on" mode) ---
    //
    // EVERY turn goes through orchestrate and dispatch comes from
    // decision_envelope.action (with regex as fallback when the envelope is
    // missing/malformed). The regex result is forwarded as `regexHint` in the
    // request body. The former regex short-circuit for high-confidence intents
    // was removed in Phase 9 (Batch 3).
    if (useUnifiedOrchestratorMode === "on") {
      const isRoomContext = currentState.stage === "HOTEL_EXPLORATION" || currentState.stage === "ROOM_SELECTED"

      // Phase 4: always send transcript for non-PROFILE_COLLECTION turns.
      // Same 80-message cap as the PROFILE_COLLECTION branch. Without this
      // the server saw only stale client state — partySize/guestComposition/
      // travelPurpose frequently lag behind what the guest actually said
      // because extraction is debounced across multiple stores.
      const conversationHistory = allMessages
        .slice(-80)
        .map((m) => ({
          role: m.sender === MessageSender.AVATAR ? ("avatar" as const) : ("user" as const),
          text: m.message,
        }))

      let cancelled = false
      const orchestrateStart = Date.now()
      ;(async () => {
        // Snapshot the freshest profile/derivedProfile at call time so we don't
        // capture stale closure values. Using refs also lets us drop profile &
        // derivedProfile from this effect's deps array (they churn constantly
        // during a session and were silently cancelling in-flight orchestrate
        // calls via the `cancelled` cleanup below).
        const liveProfile = profileRef.current
        const liveDerived = derivedProfileRef.current
        const result = await orchestrateLLM({
          message: latestMessage,
          state: currentState,
          guestFirstName: liveProfile.firstName,
          travelPurpose: liveProfile.travelPurpose ?? liveDerived.travelPurpose,
          interests: liveProfile.interests,
          rooms: isRoomContext ? rooms.map((r) => ({ id: r.id, name: r.name, occupancy: parseInt(r.occupancy, 10) || 2, price: r.price })) : undefined,
          partySize: (liveProfile.familySize ?? liveDerived.partySize) ?? undefined,
          budgetRange: liveProfile.budgetRange ?? undefined,
          guestComposition: liveProfile.guestComposition ?? liveDerived.guestComposition ?? undefined,
          regexHint: regexIntent.type,
          conversationHistory,
        })
        const latencyMs = Date.now() - orchestrateStart
        if (cancelled) return

        if (!result) {
          // Orchestrate failed — fall back to regex + hardcoded speech
          logTurn({
            stage,
            latestMessage: turnMessageSlice,
            regexIntent: regexIntent.type,
            llmIntent: null,
            action: { type: "USER_INTENT", intent: regexIntent.type },
            speech: null,
            latencyMs,
            pathway: "fallback",
          })
          processIntent(regexIntent, latestMessage, currentState, stage)
          return
        }

        // --- Phase 3 "on" mode: route via decision_envelope.action when
        // the envelope carries a USER_INTENT. ROOM_PLAN_ACTION and
        // PROFILE_TURN_RESULT envelopes fall through to the tool-based
        // dispatch below — those have dedicated handlers that do more than
        // just hand an intent to the reducer.
        const envelope = result.decision_envelope
        const envelopeAction = envelope?.action
        if (envelopeAction && envelopeAction.type === "USER_INTENT") {
          // envelopeAction.intent is a STRING (the intent tag) on the wire —
          // see lib/orchestrator/types.ts. processIntent + the reducer both
          // want a full UserIntent union object. Rebuild it here.
          //
          // AMENITY_BY_NAME carries an amenityName that the server ships in
          // two places: the envelope's top-level `amenityName` (also mirrored
          // into params.amenityName) AND the legacy tool field on `result`.
          // Prefer the envelope, fall back to result for safety.
          const intentTag = envelopeAction.intent
          const amenityName =
            (typeof envelopeAction.amenityName === "string" && envelopeAction.amenityName) ||
            (envelopeAction.params && typeof envelopeAction.params.amenityName === "string"
              ? (envelopeAction.params.amenityName as string)
              : undefined) ||
            (result.tool === "navigate_and_speak" && result.intent.type === "AMENITY_BY_NAME"
              ? result.intent.amenityName
              : undefined)

          const fullIntentObject: UserIntent =
            intentTag === "AMENITY_BY_NAME" && amenityName
              ? { type: "AMENITY_BY_NAME", amenityName }
              : ({ type: intentTag } as UserIntent)

          // eslint-disable-next-line no-console
          console.log("[ENVELOPE-DISPATCH]", {
            intent: fullIntentObject,
            speech: envelope.speech,
          })

          logTurn({
            stage,
            latestMessage: turnMessageSlice,
            regexIntent: regexIntent.type,
            llmIntent: intentTag,
            action: { type: "USER_INTENT", intent: intentTag },
            speech: envelope.speech,
            latencyMs,
            pathway: "orchestrate",
          })
          // Phase 9: apply any mid-conversation profile correction the LLM
          // attached to this envelope, regardless of whether dispatch came
          // from regex or envelope action. Profile writes are idempotent.
          applyOrchestrateProfileUpdates(
            (envelope as { profileUpdates?: Record<string, unknown> }).profileUpdates,
            "envelope",
          )
          preGeneratedSpeechRef.current = envelope.speech
          processIntent(fullIntentObject, latestMessage, currentState, stage)
          // Phase 2 Room Planner: sole room brain when the rooms panel is
          // open. Fires for every non-exit, non-internal-nav utterance; see
          // `maybeKickRoomPlanner` above for the gate.
          maybeKickRoomPlanner(intentTag, latestMessage)
          logDecisionCompare(
            { type: "USER_INTENT", intent: intentTag },
            envelope,
          )
          return
        }

        if (result.tool === "no_action_speak") {
          logTurn({
            stage,
            latestMessage: turnMessageSlice,
            regexIntent: regexIntent.type,
            llmIntent: "NO_ACTION",
            action: null,
            speech: result.speech,
            latencyMs,
            pathway: "orchestrate",
          })
          applyOrchestrateProfileUpdates(
            (result as { profileUpdates?: Record<string, unknown> }).profileUpdates,
            "no_action_speak",
          )
          interrupt()
          repeat(result.speech).catch(() => undefined)
          logDecisionCompare({ type: "NO_ACTION" }, result.decision_envelope)
          return
        }

        if (result.tool === "profile_turn") {
          // profile_turn is only expected during PROFILE_COLLECTION; if the
          // model picks it outside that stage, just speak it and bail.
          logTurn({
            stage,
            latestMessage: turnMessageSlice,
            regexIntent: regexIntent.type,
            llmIntent: "PROFILE_TURN",
            action: { type: "PROFILE_TURN", decision: result.decision },
            speech: result.speech,
            latencyMs,
            pathway: "orchestrate",
          })
          interrupt()
          repeat(result.speech).catch(() => undefined)
          logDecisionCompare(
            { type: "PROFILE_TURN_RESULT", decision: result.decision },
            result.decision_envelope,
          )
          return
        }

        // Fallthrough: navigate_and_speak without a usable envelope. Phase 3
        // "on" mode prefers the envelope path above — reaching here means the
        // server responded with the legacy tool shape but the envelope was
        // missing or malformed. Log [ENVELOPE-FALLBACK] and dispatch on the
        // tool's intent (legacy behavior).
        // eslint-disable-next-line no-console
        console.log("[ENVELOPE-FALLBACK]", {
          reason: envelope ? "non-USER_INTENT envelope action" : "envelope missing",
          tool: result.tool,
          intent: result.intent.type,
          regexHint: regexIntent.type,
        })
        logTurn({
          stage,
          latestMessage: turnMessageSlice,
          regexIntent: regexIntent.type,
          llmIntent: result.intent.type,
          action: { type: "USER_INTENT", intent: result.intent.type },
          speech: result.speech,
          latencyMs,
          pathway: "orchestrate",
        })
        applyOrchestrateProfileUpdates(
          (result as { profileUpdates?: Record<string, unknown> }).profileUpdates,
          "navigate_and_speak",
        )
        preGeneratedSpeechRef.current = result.speech
        processIntent(result.intent, latestMessage, currentState, stage)
        // Phase 1 Room Planner: fallback path — same room-edit intent gate
        // as the envelope branch above. Covers the case where the envelope
        // shape is missing/malformed but the legacy tool carried a room-edit
        // intent.
        maybeKickRoomPlanner(result.intent.type, latestMessage)
        logDecisionCompare(
          { type: "USER_INTENT", intent: result.intent.type },
          result.decision_envelope,
        )
      })()
      return () => { cancelled = true }
    }

    // --- Unified "off" mode: regex classifies and dispatches directly ---
    // No parallel LLM re-classifier. Orchestrate "shadow" / "on" modes above
    // handle LLM-driven dispatch; this path is the pure-regex baseline.
    logTurn({
      stage,
      latestMessage: turnMessageSlice,
      regexIntent: regexIntent.type,
      llmIntent: null,
      action: { type: "USER_INTENT", intent: regexIntent.type },
      speech: null,
      latencyMs: 0,
      pathway: "regex-shortcircuit",
    })
    processIntent(regexIntent, latestMessage, currentState, stage)
    // Phase 1 Room Planner: see comment in shadow branch above.
    maybeKickRoomPlanner(regexIntent.type, latestMessage)

    // Note: `profile` and `derivedProfile` are intentionally NOT in this deps
    // array. They churn constantly during a session (ProfileSync updates,
    // regex extractor updates per transcription) — every churn re-runs this
    // effect and fires the `cancelled = true`
    // cleanup on the previous run, which silently killed legitimate in-flight
    // orchestrate calls (see Phase 3 on-mode blocker). We read the freshest
    // profile/derivedProfile via profileRef.current / derivedProfileRef.current
    // at call time inside the on-mode IIFE instead.
  }, [userMessages, dispatch, trackQuestion, trackRequirement, processIntent, rooms, useUnifiedOrchestrator, useUnifiedOrchestratorMode, profileStageUsesOrchestrate, fireShadowOrchestrate, interrupt, repeat, maybeKickRoomPlanner])

  // --- Abort in-flight PROFILE_COLLECTION orchestrate on stage transition ---
  // When the journey leaves PROFILE_COLLECTION (e.g., FORCE_ADVANCE fired),
  // any still-pending profile orchestrate response should not land — the
  // stage guard inside the IIFE already blocks dispatch, but the abort makes
  // the cancellation explicit at the network layer and frees the ref. This
  // effect is deliberately separated from the user-messages effect so its
  // dep list is minimal: aborting on every profile/userMessages re-render
  // would kill legitimate in-flight calls.
  useEffect(() => {
    if (journeyStage !== "PROFILE_COLLECTION") {
      abortStaleProfileOrchestrate("stage-change")
    }
  }, [journeyStage, abortStaleProfileOrchestrate])

  // --- Abort in-flight PROFILE_COLLECTION orchestrate on unmount ---
  // Empty dep list so this cleanup only fires on component unmount, not on
  // every re-render. Prevents orphan fetches when the page closes.
  useEffect(() => {
    return () => {
      const controller = profileOrchestrateAbortRef.current
      if (controller && !controller.signal.aborted) {
        // eslint-disable-next-line no-console
        console.log("[ORCHESTRATE-ABORT]", { reason: "unmount" })
        controller.abort()
      }
      profileOrchestrateAbortRef.current = null
    }
  }, [])

  // --- Announce destination overlay when stage transitions ---
  useEffect(() => {
    if (journeyStage !== "DESTINATION_SELECT") {
      destinationAnnouncedRef.current = false
      return
    }
    if (destinationAnnouncedRef.current) return
    destinationAnnouncedRef.current = true

    const timer = setTimeout(() => {
      const text =
        "Based on what you've told me, I think you'll love these options. Take a look — tap any card to step inside the digital twin."
      interrupt()
      void repeat(text).catch(() => undefined)
    }, 500)
    return () => clearTimeout(timer)
  }, [journeyStage, interrupt, repeat])

  // --- Direct handlers (Phase 8: replaced EventBus subscriptions) ---
  // Consumers (home page, UE5 bridge) call these directly — no pub/sub hop.

  const onHotelSelected = useCallback((payload: { slug: string }) => {
    dispatch({
      type: "HOTEL_PICKED",
      slug: payload.slug,
      hotelName: "",
      location: "",
      description: "",
    })
  }, [dispatch])

  const onRoomCardTapped = useCallback(
    (payload: { roomId: string; roomName: string; occupancy: string }) => {
      stopExplorationTimer()
      trackRoomExplored(payload.roomId)
      currentRoomIdRef.current = payload.roomId

      dispatch({
        type: "ROOM_CARD_TAPPED",
        roomName: payload.roomName,
        occupancy: payload.occupancy,
        roomId: payload.roomId,
      })
    },
    [dispatch, stopExplorationTimer, trackRoomExplored],
  )

  const onUnitSelectedUE5 = useCallback(
    (payload: { roomName: string; description?: string; price?: string; level?: string }) => {
      dispatch({
        type: "UNIT_SELECTED_UE5",
        roomName: payload.roomName,
      })
      options.onUnitSelected?.(payload.roomName)
    },
    [dispatch, options],
  )

  const onAmenityCardTapped = useCallback(
    (payload: { amenityId: string; name: string; scene: string }) => {
      stopExplorationTimer()
      trackAmenityExplored(payload.name)
      startAmenityTimer(payload.name)
      dispatch({
        type: "AMENITY_CARD_TAPPED",
        name: payload.name,
        scene: payload.scene,
        amenityId: payload.amenityId,
        visitedAmenities: getVisitedAmenityNames(),
        allAmenities: amenityRefs,
      })
    },
    [dispatch, stopExplorationTimer, trackAmenityExplored, startAmenityTimer, getVisitedAmenityNames, amenityRefs],
  )

  const onNavigateBack = useCallback(() => {
    stopExplorationTimer()
    dispatch({ type: "USER_INTENT", intent: { type: "BACK" } })
  }, [dispatch, stopExplorationTimer])

  // Stable ref to onRoomCardTapped so the user-messages effect (which calls
  // it from the fuzzy room-name match branch) doesn't need it in its deps.
  const onRoomCardTappedRef = useRef(onRoomCardTapped)
  useEffect(() => {
    onRoomCardTappedRef.current = onRoomCardTapped
  })

  return {
    dispatch,
    getInternalState,
    onHotelSelected,
    onRoomCardTapped,
    onUnitSelectedUE5,
    onAmenityCardTapped,
    onNavigateBack,
  }
}
