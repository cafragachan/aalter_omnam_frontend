"use client"

import { useCallback, useEffect, useRef } from "react"
import { useUserProfileContext } from "@/lib/context"
import { useOmnamStore } from "@/lib/omnam-store"
import { useAuth } from "@/lib/auth-context"
import { useUserProfile as useHeyGenUserProfile } from "@/lib/liveavatar"
import { useAvatarActions as useHeyGenAvatarActions, lastRepeatCalledAtMsRef } from "@/lib/liveavatar/useAvatarActions"
import { useLiveAvatarContext as useHeyGenLiveAvatarContext } from "@/lib/liveavatar/context"
import { MessageSender } from "@/lib/liveavatar/types"
import { useGuestIntelligence } from "@/lib/guest-intelligence"
import { classifyIntent, type UserIntent } from "./intents"
import { orchestrateLLM } from "./orchestrateLLM"
import { buildAmenityNarrative, intentToShortcutTarget, profileCollectionAwaiting } from "./journey-machine"
import type { ProfileAwaiting } from "./profileFastPath"
import { evaluateDeterministicProfileTurn } from "./profileDeterministic"
import { evaluateDeterministicExplorationTurn } from "./explorationDeterministic"
import { useIdleDetection } from "./idle-detection"
import type { JourneyState, JourneyAction, JourneyEffect, AmenityRef } from "./types"
import { renderSpeech } from "./speech-renderer"
import { logTurn, logEffect, logLatency, type EffectEntry } from "@/lib/debug"
import {
  getRecommendedAmenity,
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

// Delay between Phase 1 (USER_INTENT shortcut → startTEST + travel) and Phase 2
// (panel-open / amenity nav). Gives UE5's server-travel time to settle so the
// follow-up nav command (gameEstate / communal) lands on the loaded level.
const UE5_POST_TRAVEL_DELAY_MS = 3500

// ---------------------------------------------------------------------------
// Speech-authority rule (=on dispatch).
//
// When the reducer authors canonical speech for an intent — either directly
// (e.g., `pullUpRooms`, `hotelBackOverview`) or via a follow-up action it
// dispatches (e.g., AMENITIES → `LIST_AMENITIES` → `amenityListing` which
// reads actual hotel data + travel-purpose recommendation) — the reducer's
// speech is the source of truth. The LLM envelope speech for these intents
// is almost always a paraphrase or, worse, a hallucinated list that
// contradicts ground truth.
//
// Rule: if the intent is in this set, NULL `preGeneratedSpeechRef` before
// dispatch so the reducer's rendered speech plays. If not in the set, keep
// the LLM envelope speech — those intents either have no canonical reducer
// speech (UNKNOWN, unrecognized fallback) or the LLM's warmth is preferable
// to the reducer's tone (AFFIRMATIVE / TRAVEL_TO_HOTEL transitions).
//
// Consequence: adding a new intent that the reducer speaks canonically
// requires adding it here. That's the price of the invariant.
// ---------------------------------------------------------------------------
const CANONICAL_REDUCER_INTENTS: ReadonlySet<string> = new Set([
  "AMENITIES",       // → LIST_AMENITIES → amenityListing (actual hotel data)
  "ROOMS",           // → pullUpRooms (+ room planner speaks the plan after)
  "LOCATION",        // → showLocation
  "BACK",            // → hotelBackOverview / backToOtherRooms / backToHotelOverview
  "BOOK",            // → bookPickRoom
  "HOTEL_EXPLORE",   // → hotelBackOverview
  "OTHER_OPTIONS",   // → otherOptionsRooms (or AMENITY_VIEWING list flow)
])

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
   * When true, PROFILE_COLLECTION runs a deterministic parser/confidence gate
   * before escalating to the LLM. High-confidence deterministic turns speak
   * locally and do not start a background LLM call, preserving one speech
   * authority per user turn. Default: true. Set to false (or
   * NEXT_PUBLIC_PROFILE_FAST_PATH=false) for rollback to the pure LLM path.
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

  // Phase 2.5: default ON. Caller passes false to disable.
  const useProfileFastPath = options.useProfileFastPath ?? true

  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const { userProfile: authIdentity, returningUserData } = useAuth()
  const { profile: derivedProfile, isExtractionPending, userMessages } = useHeyGenUserProfile()
  const {
    messages: allMessages,
    isAvatarTalking,
    lastUserSpeakEndedAtRef,
    lastUserSpeakEndedAtMsRef,
    lastAvatarSpeakStartedAtMsRef,
    sessionIdRef,
  } = useHeyGenLiveAvatarContext()
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
  const currentRoomNameRef = useRef<string | null>(null)

  // Pre-hotel shortcut: pending Phase 2 timer. Cleared on unmount and on any
  // new shortcut so a rapid second utterance doesn't double-fire.
  const shortcutFollowupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelShortcutFollowup = useCallback(() => {
    if (shortcutFollowupTimerRef.current) {
      clearTimeout(shortcutFollowupTimerRef.current)
      shortcutFollowupTimerRef.current = null
    }
  }, [])

  // --- Pre-generated speech ref (Phase 4: orchestrate fills this before processIntent) ---
  const preGeneratedSpeechRef = useRef<string | null>(null)

  // --- Per-turn latency instrumentation ---
  // One row logged per user→avatar turn as `[TURN-LATENCY]` so we can see
  // where time is going (debounce wait vs orchestrate vs HeyGen TTS).
  // t0 = user transcription lands, t1 = debounce timer fires, t2 = fetch
  // start, t3 = fetch end, t5 = AVATAR_SPEAK_STARTED. The gap t3→t5 includes
  // the repeat() WebSocket send + HeyGen TTS warmup; if that's the dominant
  // slice, no client-side refactor will help.
  //
  // NOTE the dual clock: `t0/t1/t2/t3` are `performance.now()` (monotonic,
  // good for in-process deltas). The `*Ms` fields below are `Date.now()`
  // wall-clock so they can be diffed against server-side timestamps the
  // orchestrate response echoes back. Both are needed: monotonic for the
  // existing rolling-summary console log, wall-clock for the per-session
  // log file in `logs/`.
  type TurnTiming = {
    t0: number
    t1?: number
    t2?: number
    t3?: number
    userSpeakEndedAt?: number
    message: string
    stage: string
    // ---- Fields powering the human-readable per-session log file ----
    /** UUID v4 minted at t0; threaded through orchestrate to correlate server timing. */
    turnId: string
    /** Date.now ms at user transcription land. */
    userTranscriptionAtMs: number
    /** Date.now ms at HeyGen USER_SPEAK_ENDED (snapshot from context). */
    userSpeakEndedAtMs?: number
    /** Date.now ms right after `classifyIntent()` returned. */
    intentClassifiedAtMs?: number
    /** Date.now ms right before client `fetch("/api/orchestrate")`. */
    orchestrateRequestSentMs?: number
    /** Date.now ms after `await res.json()` resolved. */
    orchestrateResponseReceivedMs?: number
    /** Server-side per-segment timings echoed in the orchestrate response. */
    serverTimings?: import("@/lib/debug").ServerTimings | null
    /** Avatar's spoken response text for the log header. */
    speech?: string | null
    /** Which dispatch path produced this turn. */
    pathway?: string
  }
  const turnTimingRef = useRef<TurnTiming | null>(null)
  // Marker for the previous turn's USER_TRANSCRIPTION wall-clock time. Used
  // to guard against HeyGen's late-firing USER_SPEAK_ENDED — the SDK
  // sometimes emits the speak-ended event AFTER the transcription, which
  // repopulates the speakEnded ref AFTER our `t0` cleared it. The next
  // turn's `t0` would then read that stale value and compute an STT segment
  // spanning multiple turns. Discarding any speakEnded value <= the
  // previous transcription cleanly catches the late-fire case.
  const previousTranscriptionMsRef = useRef<number>(0)
  // Same idea for the perf.now-based ref used by the existing TURN-LATENCY
  // console summary. Captured at the same moment as the wall-clock version
  // so both filters use a consistent boundary.
  const previousTranscriptionPerfRef = useRef<number>(0)
  const markTurnTiming = useCallback(
    (mark: "t0" | "t1" | "t2" | "t3", info?: { message?: string; stage?: string; userSpeakEndedAt?: number | null }) => {
      const now = performance.now()
      if (mark === "t0") {
        const nowMs = Date.now()
        // Wall-clock guard: drop late-firing USER_SPEAK_ENDED that landed
        // after the previous turn's transcription (it's for the prior turn,
        // not this one).
        let userSpeakEndedAtMs: number | undefined = lastUserSpeakEndedAtMsRef.current ?? undefined
        if (
          userSpeakEndedAtMs !== undefined &&
          userSpeakEndedAtMs <= previousTranscriptionMsRef.current
        ) {
          userSpeakEndedAtMs = undefined
        }
        // Perf-clock guard mirrors the same logic for the existing console
        // latency summary so its STT numbers stop showing cross-turn drift.
        let userSpeakEndedAt: number | undefined =
          typeof info?.userSpeakEndedAt === "number" &&
          info.userSpeakEndedAt <= now &&
          now - info.userSpeakEndedAt < 30_000
            ? info.userSpeakEndedAt
            : undefined
        if (
          userSpeakEndedAt !== undefined &&
          userSpeakEndedAt <= previousTranscriptionPerfRef.current
        ) {
          userSpeakEndedAt = undefined
        }
        const turnId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `t_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 10)}`
        turnTimingRef.current = {
          t0: now,
          userSpeakEndedAt,
          message: info?.message ?? "",
          stage: info?.stage ?? "",
          turnId,
          userTranscriptionAtMs: nowMs,
          userSpeakEndedAtMs,
        }
        // Update the boundary markers BEFORE clearing the speak-ended refs
        // so the next turn's guard knows where this turn ended.
        previousTranscriptionMsRef.current = nowMs
        previousTranscriptionPerfRef.current = now
        // Clear the speak-ended refs after consumption so the NEXT turn doesn't
        // inherit this turn's value when HeyGen doesn't fire USER_SPEAK_ENDED
        // before USER_TRANSCRIPTION. The stale-fire case above is the second
        // belt-and-suspenders guard — late events repopulate the ref but the
        // boundary check then drops them.
        lastUserSpeakEndedAtRef.current = null
        lastUserSpeakEndedAtMsRef.current = null
        return
      }
      const t = turnTimingRef.current
      if (!t) return
      t[mark] = now
      // Mirror the perf-clock marks into wall-clock fields so the per-session
      // log file (which runs in Date.now ms across processes) can use them.
      if (mark === "t2") t.orchestrateRequestSentMs = Date.now()
      else if (mark === "t3") t.orchestrateResponseReceivedMs = Date.now()
    },
    [lastUserSpeakEndedAtMsRef],
  )

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

  // --- Unified `=on` orchestrator debounce + abort (non-PC stages) ---
  // Port of PC's (debounce + AbortController) primitive to the non-PC stages.
  // Without this, rapid HeyGen VAD fragments each fire their own orchestrate
  // call and every prior response is dropped via a `cancelled` flag — leaving
  // the avatar silent and eventually letting idle-reengage speak over
  // already-expressed intent. See `plans/unified-orchestrator-cascade-fix.md`.
  const unifiedTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unifiedTurnAbortRef = useRef<AbortController | null>(null)

  const killCurrentUnifiedTurn = useCallback(
    (reason: "new-turn" | "stage-change" | "unmount") => {
      if (unifiedTurnTimerRef.current) {
        clearTimeout(unifiedTurnTimerRef.current)
        unifiedTurnTimerRef.current = null
      }
      const controller = unifiedTurnAbortRef.current
      if (controller && !controller.signal.aborted) {
        // eslint-disable-next-line no-console
        console.log("[UNIFIED-TURN-ABORT]", { reason })
        controller.abort()
      }
      unifiedTurnAbortRef.current = null
    },
    [],
  )

  // --- Phase 2.5 fast-path state ---
  // Tracks the previous `profileCollectionAwaiting(...)` value so each user
  // turn can tell whether regex extraction made progress this turn.
  // Initial "dates_and_guests" matches INITIAL_JOURNEY_STATE.awaiting.
  const prevAwaitingRef = useRef<ProfileAwaiting>("dates_and_guests")
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
  // Live refs for amenities + visited amenity names so dispatchListAmenities
  // and navigateToAmenityByName see fresh data even when their callers
  // (the pre-hotel shortcut's Phase-2 setTimeout) captured an older closure.
  // The shortcut from PROFILE_COLLECTION schedules Phase 2 BEFORE the
  // SELECT_HOTEL effect's render lands, so the closure-captured `amenities`
  // is the empty pre-hotel array. Refs sidestep that race.
  const amenitiesRef = useRef(amenities)
  const visitedAmenityNamesRef = useRef<string[]>([])
  useEffect(() => {
    profileRef.current = profile
    derivedProfileRef.current = derivedProfile
    isExtractionPendingRef.current = isExtractionPending
    amenitiesRef.current = amenities
    visitedAmenityNamesRef.current = guestIntelligence.data.amenitiesExplored.map((a) => a.name)
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
      const hasAdults = typeof gc.adults === "number"
      const hasChildren = typeof gc.children === "number"
      if (hasAdults || hasChildren) {
        // Declaring a new composition — default the missing side to 0 so
        // downstream schemas (room-planner requires both fields as numbers)
        // and familySize math don't see NaN. See the profile_turn APPLY
        // path in this file for the same normalization.
        const adults = hasAdults ? gc.adults! : 0
        const children = hasChildren ? gc.children! : 0
        updates.guestComposition = {
          adults,
          children,
          ...(gc.childrenAges ? { childrenAges: gc.childrenAges } : {}),
        }
        updates.familySize = adults + children
      } else {
        // Partial update (e.g. ages only). Pass through and let the store's
        // deep-merge keep prior adults/children.
        updates.guestComposition = gc as import("@/lib/context").GuestComposition
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
  //
  // Both helpers read amenities + travel-purpose + visited-names via refs,
  // not closure-captured props. This keeps their function identity stable
  // AND — critically — lets a stale-closure caller (the pre-hotel shortcut's
  // Phase-2 setTimeout, scheduled BEFORE SELECT_HOTEL's render lands) still
  // see the fresh post-render data at fire time.

  // --- Voice-driven amenity navigation (dispatches rich action to reducer) ---
  const navigateToAmenityByName = useCallback((amenityName: string) => {
    const liveAmenities = amenitiesRef.current
    const normalized = AMENITY_ALIASES[amenityName.toLowerCase()] ?? amenityName.toLowerCase()

    // 1. Active match → navigate normally.
    const match = liveAmenities.find((a) => {
      const n = a.name.toLowerCase()
      const s = a.scene.toLowerCase()
      return n.includes(normalized) || s.includes(normalized)
    })

    if (match) {
      trackAmenityExplored(match.name)
      startAmenityTimer(match.name)
      dispatch({
        type: "NAVIGATE_TO_AMENITY",
        amenity: { id: match.id, name: match.name, scene: match.scene },
        narrative: buildAmenityNarrative(match.name, match.scene),
        visitedAmenities: visitedAmenityNamesRef.current,
        allAmenities: liveAmenities.map((a): AmenityRef => ({ id: a.id, name: a.name, scene: a.scene })),
      })
      return
    }

    // 2. Described-only match → the amenity exists at the property but has
    //    no UE5 scene yet. Speak a redirect using the amenity's
    //    shortDescription (when available) and offer a visitable
    //    alternative. Critically: do NOT dispatch any reducer action and do
    //    NOT emit a UE5 `communal` command — the scene doesn't exist.
    const describedOnly = catalogRef.current?.amenitiesDescribedOnly ?? []
    const describedMatch = describedOnly.find((a) => {
      const n = a.name.toLowerCase()
      const s = a.scene.toLowerCase()
      return n.includes(normalized) || s.includes(normalized)
    })
    if (describedMatch) {
      const blurb = describedMatch.shortDescription ?? describedMatch.description ?? ""
      const visitableAlt = liveAmenities[0]?.name?.toLowerCase()
      const fallbackOffer = visitableAlt
        ? `Would you like me to take you to the ${visitableAlt} instead?`
        : "Would you like to see the rooms or explore the surrounding area instead?"
      const text = blurb
        ? `${describedMatch.name} — ${blurb} The live tour doesn't reach that space just yet. ${fallbackOffer}`
        : `${describedMatch.name} is one of our property's offerings, but it's not part of the live tour just yet. ${fallbackOffer}`
      interrupt()
      void repeat(text).catch(() => undefined)
      return
    }

    // 3. No match anywhere — speak the legacy "we don't have one" line.
    const text = `I don't think we have a ${amenityName} at this property. Would you like to see the rooms, or explore the surrounding area?`
    interrupt()
    void repeat(text).catch(() => undefined)
  }, [trackAmenityExplored, startAmenityTimer, interrupt, repeat, dispatch])

  /** Dispatch LIST_AMENITIES action with pre-computed hotel data */
  const dispatchListAmenities = useCallback(() => {
    const liveAmenities = amenitiesRef.current
    const liveTravelPurpose = profileRef.current.travelPurpose
    const recommended = getRecommendedAmenity(liveAmenities, liveTravelPurpose)
    // Pull described-only amenity names from the catalog so the listing
    // speech can mention them ("we also have a spa, two restaurants, and
    // a gym I can tell you about") even though they're not visitable.
    const describedOnlyAmenityNames = (catalogRef.current?.amenitiesDescribedOnly ?? [])
      .map((a) => a.name)
    dispatch({
      type: "LIST_AMENITIES",
      visitedAmenities: visitedAmenityNamesRef.current,
      allAmenities: liveAmenities.map((a): AmenityRef => ({ id: a.id, name: a.name, scene: a.scene })),
      travelPurpose: liveTravelPurpose,
      recommendedAmenityName: recommended?.name,
      ...(describedOnlyAmenityNames.length > 0 ? { describedOnlyAmenityNames } : {}),
    })
  }, [dispatch])

  // --- Idle detection (re-engagement) ---
  const handleIdle = useCallback(() => {
    dispatch({ type: "IDLE_TIMEOUT" })
  }, [dispatch])

  const { resetTimer: resetIdleTimer } = useIdleDetection({
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
    // --- Pre-hotel shortcut interception ---
    // From PROFILE_COLLECTION or VIRTUAL_LOUNGE, a content intent (rooms /
    // amenities / a specific amenity / location / hotel) shortcuts straight
    // to HOTEL_EXPLORATION. Phase 1 (the reducer) emits SELECT_HOTEL +
    // startTEST + fade + upfront speech. Phase 2 (here, on a 1.2s timer)
    // fires the secondary nav so UE5's server-travel has time to land.
    if (stage === "PROFILE_COLLECTION" || stage === "VIRTUAL_LOUNGE") {
      const shortcutTarget = intentToShortcutTarget(intent)
      // VIRTUAL_LOUNGE.asking treats AFFIRMATIVE as "explore the lounge" —
      // never a hotel shortcut. Same for VIRTUAL_LOUNGE.exploring's
      // TRAVEL_TO_HOTEL/AFFIRMATIVE/NEGATIVE branch which speaks hotelWelcome.
      // Let those fall through to the regular dispatch below.
      const isLoungeAskingAffirmative = stage === "VIRTUAL_LOUNGE" &&
        currentState.stage === "VIRTUAL_LOUNGE" && currentState.subState === "asking" &&
        intent.type === "AFFIRMATIVE"
      const isLoungeExploringTravel = stage === "VIRTUAL_LOUNGE" &&
        currentState.stage === "VIRTUAL_LOUNGE" && currentState.subState === "exploring" &&
        (intent.type === "TRAVEL_TO_HOTEL" || intent.type === "AFFIRMATIVE" || intent.type === "NEGATIVE")

      if (shortcutTarget && !isLoungeAskingAffirmative && !isLoungeExploringTravel) {
        cancelShortcutFollowup()
        dispatch({ type: "USER_INTENT", intent })

        // For target === "hotel", just travel + welcome, no Phase 2.
        if (shortcutTarget === "hotel") return

        // For amenities, schedule the LIST_AMENITIES dispatch — the rich
        // listing speech (curated by travel purpose) interrupts Phase 1's
        // intro at ~1.2s. No UE5 cmd fires here; the user picks an amenity
        // afterward, and AMENITY_CARD_TAPPED / NAVIGATE_TO_AMENITY handles
        // the `communal` cmd at that point (well after server-travel).
        if (shortcutTarget === "amenities") {
          shortcutFollowupTimerRef.current = setTimeout(() => {
            shortcutFollowupTimerRef.current = null
            dispatchListAmenities()
          }, UE5_POST_TRAVEL_DELAY_MS)
          return
        }

        if (shortcutTarget === "amenity_by_name" && intent.type === "AMENITY_BY_NAME") {
          const amenityName = intent.amenityName
          shortcutFollowupTimerRef.current = setTimeout(() => {
            shortcutFollowupTimerRef.current = null
            navigateToAmenityByName(amenityName)
          }, UE5_POST_TRAVEL_DELAY_MS)
          return
        }

        // rooms / location: silent panel open via SHORTCUT_FOLLOWUP. The
        // bridge translates OPEN_PANEL → gameEstate UE5 cmd.
        if (shortcutTarget === "rooms" || shortcutTarget === "location") {
          shortcutFollowupTimerRef.current = setTimeout(() => {
            shortcutFollowupTimerRef.current = null
            dispatch({ type: "SHORTCUT_FOLLOWUP", target: shortcutTarget })
          }, UE5_POST_TRAVEL_DELAY_MS)
          return
        }
      }
    }

    // --- Exploration timer management ---
    if (stage === "ROOM_SELECTED" && (intent.type === "INTERIOR" || intent.type === "EXTERIOR")) {
      if (currentRoomIdRef.current) {
        startRoomTimer(currentRoomIdRef.current, currentRoomNameRef.current ?? undefined)
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

    // Bare "yes" in HOTEL_EXPLORATION with a suggestedAmenityName standing
    // proposal (from a just-listed amenities response) → resolve to that
    // amenity. This is safe because the avatar's immediately-prior utterance
    // concretely proposed it.
    //
    // NOTE: we used to also resolve AFFIRMATIVE → suggestedNext in
    // AMENITY_VIEWING, but the LLM's freestyled speech there ("want to know
    // more about the pool?") frequently invited yes/no about STAYING rather
    // than advancing. The interception then hijacked the transition to the
    // suggestedNext amenity, producing a "said yes, got teleported" UX.
    // Now the LLM is authoritative for AMENITY_VIEWING turns: if it proposes
    // advancement, it emits navigate_and_speak:AMENITY_BY_NAME(suggestedNext);
    // if it proposes staying with more details, it emits no_action_speak.
    // See the AMENITY_VIEWING prompt block in /api/orchestrate for the
    // contract.
    if (intent.type === "AFFIRMATIVE") {
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
  }, [dispatch, dispatchListAmenities, navigateToAmenityByName, startRoomTimer, stopExplorationTimer, isRoomsPanelVisibleRef, cancelShortcutFollowup])

  // Cancel any pending shortcut Phase-2 timer on unmount.
  useEffect(() => () => cancelShortcutFollowup(), [cancelShortcutFollowup])

  // --- Per-turn latency log emit (t5 = AVATAR_SPEAK_STARTED) ---
  // Fires once per turn when the avatar's first audio frame plays. Skipped
  // if the timing ref isn't populated (e.g., pre-warm or any speak that
  // wasn't preceded by an instrumented orchestrate call). One-shot per turn:
  // the ref is cleared after emit so a subsequent isAvatarTalking flicker
  // (interrupt + new repeat in the same turn) doesn't re-log.
  useEffect(() => {
    if (!isAvatarTalking) return
    const t = turnTimingRef.current
    if (!t) return
    const t5 = performance.now()
    const avatarSpeakStartedAtMs = lastAvatarSpeakStartedAtMsRef.current ?? Date.now()
    const round = (n: number | undefined) =>
      n === undefined ? null : Math.round(n - t.t0)
    logLatency({
      stage: t.stage,
      msg: t.message.slice(0, 60),
      totalMs: Math.round(t5 - t.t0),
      totalFromSpeechEndMs:
        t.userSpeakEndedAt !== undefined ? Math.round(t5 - t.userSpeakEndedAt) : null,
      sttFinalizationMs:
        t.userSpeakEndedAt !== undefined ? Math.round(t.t0 - t.userSpeakEndedAt) : null,
      debounceMs: round(t.t1),
      fetchStartMs: round(t.t2),
      fetchEndMs: round(t.t3),
      orchestrateMs:
        t.t2 !== undefined && t.t3 !== undefined
          ? Math.round(t.t3 - t.t2)
          : null,
      postOrchestrateToAudioMs:
        t.t3 !== undefined ? Math.round(t5 - t.t3) : null,
      // ---- Fields powering the per-session log file ----
      turnId: t.turnId,
      sessionId: sessionIdRef.current,
      pathway: t.pathway,
      speech: t.speech ?? null,
      walltimes: {
        userSpeakEnded: t.userSpeakEndedAtMs ?? null,
        userTranscription: t.userTranscriptionAtMs,
        intentClassified: t.intentClassifiedAtMs ?? null,
        orchestrateRequestSent: t.orchestrateRequestSentMs ?? null,
        orchestrateResponseReceived: t.orchestrateResponseReceivedMs ?? null,
        repeatCalled: lastRepeatCalledAtMsRef.current,
        avatarSpeakStarted: avatarSpeakStartedAtMs,
        // Avatar speech is still in progress at this moment — captured later
        // by an effect on the AVATAR_SPEAK_ENDED ref, but we leave it null
        // here to avoid blocking the per-turn flush on speech completion.
        avatarSpeakEnded: null,
      },
      serverTimings: t.serverTimings ?? null,
    })
    turnTimingRef.current = null
  }, [isAvatarTalking, lastAvatarSpeakStartedAtMsRef, sessionIdRef])

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
    markTurnTiming("t0", {
      message: latestMessage,
      stage: stateRef.current.stage,
      userSpeakEndedAt: lastUserSpeakEndedAtRef.current,
    })

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
    // Latency log: stamp the moment we know the user's classified intent.
    // This bounds the "client preflight" segment for the per-session log file.
    if (turnTimingRef.current) {
      turnTimingRef.current.intentClassifiedAtMs = Date.now()
    }
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
    // turn, then choose exactly one speech authority: deterministic parser
    // for high-confidence profile answers, otherwise the LLM.
    if (stage === "PROFILE_COLLECTION") {
      profileTurnCountRef.current += 1

      if (profileMsgDebounceRef.current) clearTimeout(profileMsgDebounceRef.current)
      profileMsgDebounceRef.current = setTimeout(() => {
        markTurnTiming("t1")
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

        if (useProfileFastPath) {
          const deterministicStart = Date.now()
          const deterministic = evaluateDeterministicProfileTurn({
            latestMessage,
            awaiting: freshAwaiting,
            profile: {
              familySize: mergedProfile.partySize ?? undefined,
              startDate: mergedProfile.startDate,
              endDate: mergedProfile.endDate,
              travelPurpose: mergedProfile.travelPurpose,
              guestComposition: mergedProfile.guestComposition,
              roomAllocation: mergedProfile.roomAllocation,
            },
          })

          if (deterministic.handled) {
            if (profileMsgDebounceRef.current) {
              profileMsgDebounceRef.current = null
            }
            abortStaleProfileOrchestrate("new-turn")
            if (Object.keys(deterministic.updates).length > 0) {
              updateProfile(deterministic.updates)
            }
            prevAwaitingRef.current = deterministic.awaiting
            logTurn({
              stage: "PROFILE_COLLECTION",
              latestMessage: latestMessage.slice(-80),
              regexIntent: null,
              llmIntent: null,
              action: {
                type: "PROFILE_TURN_RESULT",
                decision: deterministic.decision,
                awaiting: deterministic.awaiting,
                confidence: deterministic.confidence,
                reasons: deterministic.reasons,
              },
              speech: deterministic.speech,
              latencyMs: Date.now() - deterministicStart,
              pathway: "deterministic",
            })

            if (deterministic.decision === "ready") {
              preGeneratedSpeechRef.current = deterministic.speech
              dispatch({ type: "FORCE_ADVANCE" })
              return
            }

            interrupt()
            repeat(deterministic.speech).catch(() => undefined)
            return
          }
        }

        // PROFILE_COLLECTION transcript window for escalated turns. An earlier
        // slice(-10) caused the LLM to forget fields the
        // guest gave on the first turn. 24 messages comfortably covers a
        // typical onboarding (5–8 user turns × 2 + headroom) while saving
        // significant TTFT vs. the prior slice(-80).
        const conversationHistory = allMessages
          .slice(-24)
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
        // a prior turn. A non-deterministic turn that arrives while an earlier
        // orchestrate is still pending must cancel the stale request.
        abortStaleProfileOrchestrate("new-turn")
        const controller = new AbortController()
        profileOrchestrateAbortRef.current = controller
        // Reset the idle timer on turn-start so the 12s reengage doesn't
        // fire while an orchestrate is mid-flight during PROFILE_COLLECTION.
        // Mirrors the hardening applied to the =on non-PC branch.
        resetIdleTimer()

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
          markTurnTiming("t2")
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
            // Skip-ahead signal: in PC the LLM can pick navigate_and_speak
            // for explicit "show me the rooms / amenities / hotel" requests.
            // Passing the regex tag biases the model toward the right intent.
            regexHint: profileRegexIntent.type,
            conversationHistory,
            signal: controller.signal,
            turnId: turnTimingRef.current?.turnId,
          })
          markTurnTiming("t3")
          // Stitch server timings + chosen speech onto the timing ref so the
          // AVATAR_SPEAK_STARTED effect can write a complete log line.
          if (turnTimingRef.current && result?.telemetry) {
            turnTimingRef.current.serverTimings = result.telemetry.serverTimings
          }
          if (turnTimingRef.current && result) {
            turnTimingRef.current.speech = result.speech
            turnTimingRef.current.pathway = "orchestrate"
          }
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
              freshAwaiting === "ready" ||
                fallbackIntent.type === "TRAVEL_TO_HOTEL" ||
                fallbackIntent.type === "AFFIRMATIVE"
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
              const gc = pu.guestComposition
              const hasAdults = typeof gc.adults === "number"
              const hasChildren = typeof gc.children === "number"
              if (hasAdults || hasChildren) {
                // Declaring a new composition — default the missing side
                // to 0. Fixes the "all adults" case where the LLM emits
                // {adults: 8} without children, which otherwise produced
                // familySize = NaN and tripped the room-planner schema
                // (which requires children as a number).
                const adults = hasAdults ? gc.adults! : 0
                const children = hasChildren ? gc.children! : 0
                updates.guestComposition = { ...gc, adults, children }
                updates.familySize = adults + children
              } else {
                // Partial update (e.g., only childrenAges). Pass through
                // unchanged so the store's deep-merge preserves prior
                // adults/children — don't clobber them with zeros here.
                updates.guestComposition = gc
              }
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

            // Speech IS cancellable — if a newer turn is in flight, don't
            // step on it with stale dialogue.
            if (cancelled) return

            if (result.decision === "ready") {
              // why: PILOT_MODE sends ready → VIRTUAL_LOUNGE:asking, whose
              // reducer emits SPEAK_INTENT `profileReadyWelcome` ("…would you
              // like to explore our virtual lounge?"). If the LLM drifts and
              // authors "let me take you to the hotel", substituting that
              // speech misleads the guest into expecting a hotel transition
              // while the reducer is actually waiting for a yes/no about the
              // lounge. Null the override so the reducer's canned lounge-ask
              // always plays on this one transition.
              preGeneratedSpeechRef.current = null
              dispatch({ type: "FORCE_ADVANCE" })
              prevAwaitingRef.current = freshAwaiting
              return
            }

            // ask_next or clarify — speak directly, stay in PROFILE_COLLECTION.
            interrupt()
            repeat(result.speech).catch(() => undefined)
            prevAwaitingRef.current = freshAwaiting
            return
          }

          // --- navigate_and_speak in PROFILE_COLLECTION ---
          //
          // The PC prompt now exposes navigate_and_speak alongside profile_turn
          // so the LLM can honor explicit skip-ahead requests ("show me the
          // rooms / amenities / hotel / surrounding area"). Two paths:
          //
          //   1) Bare AFFIRMATIVE — legacy "I'm done, move on" → FORCE_ADVANCE
          //      (lands in VIRTUAL_LOUNGE:asking with `profileReadyWelcome`).
          //   2) Skip-ahead intent — route through processIntent so the
          //      pre-hotel shortcut runs (Phase 1 travel + Phase 2 panel
          //      open / amenity nav, all wired in journey-machine.ts +
          //      processIntent).

          if (result.tool === "navigate_and_speak") {
            const llmIntent = result.intent
            const isShortcutIntent =
              llmIntent.type === "ROOMS" || llmIntent.type === "AMENITIES" ||
              llmIntent.type === "AMENITY_BY_NAME" || llmIntent.type === "LOCATION" ||
              llmIntent.type === "HOTEL_EXPLORE" || llmIntent.type === "TRAVEL_TO_HOTEL" ||
              llmIntent.type === "BOOK"

            if (llmIntent.type === "AFFIRMATIVE") {
              // Bare "yes" during PC → "I'm done, move on" → FORCE_ADVANCE.
              // (TRAVEL_TO_HOTEL is treated as a shortcut below so it travels
              // straight to the hotel instead of stopping in the lounge.)
              logTurn({
                stage: "PROFILE_COLLECTION",
                latestMessage: profileTurnMessageSlice,
                regexIntent: profileRegexIntent.type,
                llmIntent: llmIntent.type,
                action: { type: "FORCE_ADVANCE" },
                speech: result.speech,
                latencyMs: profileLatencyMs,
                pathway: "orchestrate",
              })
              prevAwaitingRef.current = freshAwaiting
              if (cancelled) return
              // why: FORCE_ADVANCE lands in VIRTUAL_LOUNGE:asking whose
              // reducer speaks `profileReadyWelcome`. Override LLM speech so
              // the guest hears the canonical lounge prompt.
              preGeneratedSpeechRef.current = null
              dispatch({ type: "FORCE_ADVANCE" })
              return
            }

            if (isShortcutIntent) {
              logTurn({
                stage: "PROFILE_COLLECTION",
                latestMessage: profileTurnMessageSlice,
                regexIntent: profileRegexIntent.type,
                llmIntent: llmIntent.type,
                action: { type: "USER_INTENT", intent: llmIntent.type },
                speech: result.speech,
                latencyMs: profileLatencyMs,
                pathway: "orchestrate",
              })
              prevAwaitingRef.current = freshAwaiting
              if (cancelled) return
              // Use the LLM's warm acknowledgement ("Of course, taking you to
              // the rooms now") as the Phase-1 transition speech. The reducer's
              // SPEAK_INTENT effect drains preGeneratedSpeechRef.
              preGeneratedSpeechRef.current = result.speech
              processIntent(llmIntent, latestMessage, stateRef.current, "PROFILE_COLLECTION")
              return
            }

            // Any other navigate_and_speak intent during PC (UNKNOWN, lighting,
            // etc.) — speak the LLM's response without a state change.
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
          if (cancelled) return
          interrupt()
          repeat(result.speech).catch(() => undefined)
        })()
        // Day-1 latency batch: trimmed from 700→400ms. The longer wait was
        // partly to let AI extraction (800ms debounce + HTTP) complete before
        // reading derivedProfile via refs, but profile_turn re-extracts from
        // the transcript so a slightly-stale derivedProfile is harmless. The
        // AbortController above still supersedes superseded turns.
      }, 400)
      return
    }

    if (stage === "DESTINATION_SELECT") return

    const currentState = stateRef.current

    // Voice-driven room edits (single-room fuzzy match or multi-room
    // composition) are handled exclusively by the room planner via
    // `maybeKickRoomPlanner` below. The planner returns a fresh plan; the
    // UE5 selectedRoom sync effect in app/home/page.tsx re-signals UE5
    // with the concatenated room-id list on every plan change.

    const regexIntent = classifyIntent(latestMessage)
    const turnMessageSlice = latestMessage.slice(-80)

    // --- Consolidated orchestrate branch ---
    //
    // Ambiguous or content-heavy turns go through orchestrate and dispatch
    // comes from decision_envelope.action (with regex as fallback when the
    // envelope is missing/malformed). Clear exploration commands can be
    // handled deterministically before the LLM call.
    //
    // VAD-coalescing hardening (2026-04 cascade fix):
    //   • debounce 600ms — rapid HeyGen VAD fragments ("yeah sure, can I see
    //     what's here") coalesce into one orchestrate call instead of N.
    //   • real AbortController — cancelling a stale turn kills the fetch,
    //     not just the dispatch. Prevents cascading-cancellation silence.
    //   • idle-timer reset on turn start + land — stops the 12s idle from
    //     firing while an orchestrate is mid-flight and speaking a stale
    //     reengage over already-expressed intent.
    const isRoomContext = currentState.stage === "HOTEL_EXPLORATION" || currentState.stage === "ROOM_SELECTED"

    // Non-PROFILE_COLLECTION transcript window. The journey reducer carries
    // structured state (selected hotel, current stage, sub-state, last
    // proposal, suggestedNext) so the LLM mostly needs the recent few turns
    // for conversational context — not the full session. 16 messages keeps
    // mid-journey corrections ("we're 6 not 8") visible while cutting TTFT.
    const conversationHistory = allMessages
      .slice(-16)
      .map((m) => ({
        role: m.sender === MessageSender.AVATAR ? ("avatar" as const) : ("user" as const),
        text: m.message,
      }))

    // Kill any pending timer OR in-flight fetch from a prior USER_TX so
    // this new utterance supersedes it cleanly. Must happen BEFORE creating
    // the new controller so the refs point at the current turn only.
    killCurrentUnifiedTurn("new-turn")

    const controller = new AbortController()
    unifiedTurnAbortRef.current = controller

    unifiedTurnTimerRef.current = setTimeout(() => {
      unifiedTurnTimerRef.current = null
      markTurnTiming("t1")
      // Reset idle detection on turn-start so the 12s reengage can't
      // fire over a response that's about to land.
      resetIdleTimer()
      const deterministic = evaluateDeterministicExplorationTurn({
        latestMessage,
        state: currentState,
      })
      if (deterministic.handled) {
        if (unifiedTurnAbortRef.current === controller) {
          unifiedTurnAbortRef.current = null
        }
        logTurn({
          stage,
          latestMessage: turnMessageSlice,
          regexIntent: regexIntent.type,
          llmIntent: null,
          action: {
            type: "USER_INTENT",
            intent: deterministic.intent.type,
            confidence: deterministic.confidence,
            reasons: deterministic.reasons,
          },
          speech: null,
          latencyMs: 0,
          pathway: "deterministic",
        })
        preGeneratedSpeechRef.current = null
        processIntent(deterministic.intent, latestMessage, currentState, stage)
        maybeKickRoomPlanner(deterministic.intent.type, latestMessage)
        return
      }
      const orchestrateStart = Date.now()
      ;(async () => {
        // Snapshot the freshest profile/derivedProfile at call time so we don't
        // capture stale closure values. Using refs also lets us drop profile &
        // derivedProfile from this effect's deps array (they churn constantly
        // during a session and were silently cancelling in-flight orchestrate
        // calls via the `cancelled` cleanup below).
        const liveProfile = profileRef.current
        const liveDerived = derivedProfileRef.current
        const selectedRoomForContext = (() => {
          if (!isRoomContext) return undefined
          const selectedRoomId = currentRoomIdRef.current
          if (!selectedRoomId) return undefined
          const selectedRoom = rooms.find((r) => r.id === selectedRoomId)
          if (!selectedRoom) return undefined
          return {
            id: selectedRoom.id,
            name: selectedRoom.name,
            occupancy: parseInt(selectedRoom.occupancy, 10) || 2,
            price: selectedRoom.price,
            area: selectedRoom.area,
            roomType: selectedRoom.roomType,
            features: selectedRoom.features,
            view: selectedRoom.view,
            bedding: selectedRoom.bedding,
            bath: selectedRoom.bath,
            tech: selectedRoom.tech,
            services: selectedRoom.services,
          }
        })()
        // Hotel + amenity context for prompt grounding. The catalog already
        // separates active (navigable) from described-only (no UE5 scene).
        // Passing both lists lets the orchestrate prompt render the
        // visitable / described-only split AND inject full details for the
        // amenity the user is currently asking about (mirrors selectedRoom).
        const liveCatalog = catalogRef.current
        const hotelInfoForCtx = liveCatalog
          ? {
              name: liveCatalog.hotelName,
              location: liveCatalog.hotelLocation,
              ...(liveCatalog.hotelTagline ? { tagline: liveCatalog.hotelTagline } : {}),
              ...(liveCatalog.hotelDescription ? { description: liveCatalog.hotelDescription } : {}),
              ...(liveCatalog.hotelHighlights ? { highlights: liveCatalog.hotelHighlights } : {}),
              ...(liveCatalog.hotelAddress ? { address: liveCatalog.hotelAddress } : {}),
              ...(liveCatalog.hotelTags ? { tags: liveCatalog.hotelTags } : {}),
              ...(liveCatalog.hotelWebsiteUrl ? { websiteUrl: liveCatalog.hotelWebsiteUrl } : {}),
            }
          : undefined
        markTurnTiming("t2")
        const result = await orchestrateLLM({
          message: latestMessage,
          state: currentState,
          guestFirstName: liveProfile.firstName,
          travelPurpose: liveProfile.travelPurpose ?? liveDerived.travelPurpose,
          interests: liveProfile.interests,
          rooms: isRoomContext ? rooms.map((r) => ({ id: r.id, name: r.name, occupancy: parseInt(r.occupancy, 10) || 2, price: r.price })) : undefined,
          selectedRoom: selectedRoomForContext,
          // Ground the LLM in the actual hotel amenities so it doesn't
          // freestyle "spa/gym/restaurant" from the intent-enum categories.
          // Legacy field; kept for back-compat alongside the richer
          // hotelAmenitiesActive list below.
          hotelAmenityNames: amenities.map((a) => a.name),
          hotelInfo: hotelInfoForCtx,
          hotelAmenitiesActive: liveCatalog?.amenities,
          hotelAmenitiesDescribedOnly: liveCatalog?.amenitiesDescribedOnly,
          partySize: (liveProfile.familySize ?? liveDerived.partySize) ?? undefined,
          budgetRange: liveProfile.budgetRange ?? undefined,
          guestComposition: liveProfile.guestComposition ?? liveDerived.guestComposition ?? undefined,
          regexHint: regexIntent.type,
          conversationHistory,
          signal: controller.signal,
          turnId: turnTimingRef.current?.turnId,
        })
        markTurnTiming("t3")
        if (turnTimingRef.current && result?.telemetry) {
          turnTimingRef.current.serverTimings = result.telemetry.serverTimings
        }
        if (turnTimingRef.current && result) {
          turnTimingRef.current.speech = result.speech
          turnTimingRef.current.pathway = "orchestrate"
        }
        const latencyMs = Date.now() - orchestrateStart
        if (controller.signal.aborted) return
        // Reset idle detection on turn-land so the reengage countdown
        // starts from "just got a response", not from the user's utterance.
        resetIdleTimer()
        // Clear the ref only if it still points at our controller (a newer
        // turn may have already replaced it).
        if (unifiedTurnAbortRef.current === controller) {
          unifiedTurnAbortRef.current = null
        }

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

        // Route via decision_envelope.action when the envelope carries a
        // USER_INTENT. PROFILE_TURN_RESULT envelopes fall through to the
        // tool-based dispatch below — those have dedicated handlers that
        // do more than just hand an intent to the reducer.
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

          const envelopeLightingMode =
            envelopeAction.lightingMode === "daylight" ||
            envelopeAction.lightingMode === "sunset" ||
            envelopeAction.lightingMode === "night"
              ? envelopeAction.lightingMode
              : undefined
          const paramLightingMode =
            envelopeAction.params && typeof envelopeAction.params.lightingMode === "string" &&
            (envelopeAction.params.lightingMode === "daylight" ||
              envelopeAction.params.lightingMode === "sunset" ||
              envelopeAction.params.lightingMode === "night")
              ? (envelopeAction.params.lightingMode as "daylight" | "sunset" | "night")
              : undefined
          const resultLightingMode =
            result.tool === "navigate_and_speak" && result.intent.type === "LIGHTING_SET"
              ? result.intent.mode
              : undefined
          const lightingMode = envelopeLightingMode ?? paramLightingMode ?? resultLightingMode

          let fullIntentObject: UserIntent
          if (intentTag === "AMENITY_BY_NAME" && amenityName) {
            fullIntentObject = { type: "AMENITY_BY_NAME", amenityName }
          } else if (intentTag === "LIGHTING_SET" && lightingMode) {
            fullIntentObject = { type: "LIGHTING_SET", mode: lightingMode }
          } else {
            fullIntentObject = { type: intentTag } as UserIntent
          }

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
          // Apply any mid-conversation profile correction the LLM attached
          // to this envelope. Profile writes are idempotent.
          applyOrchestrateProfileUpdates(
            (envelope as { profileUpdates?: Record<string, unknown> }).profileUpdates,
            "envelope",
          )
          // Speech-authority rule: if the reducer authors canonical speech
          // for this intent, drop the LLM envelope speech so the rendered
          // canonical line plays instead. See CANONICAL_REDUCER_INTENTS at
          // the top of the file for the full rationale.
          preGeneratedSpeechRef.current =
            CANONICAL_REDUCER_INTENTS.has(intentTag) ? null : envelope.speech
          processIntent(fullIntentObject, latestMessage, currentState, stage)
          // Room Planner: sole room brain when the rooms panel is open.
          // Fires for every non-exit, non-internal-nav utterance; see
          // `maybeKickRoomPlanner` above for the gate.
          maybeKickRoomPlanner(intentTag, latestMessage)
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
          return
        }

        // Fallthrough: navigate_and_speak without a usable envelope. Reaching
        // here means the server responded with the legacy tool shape but the
        // envelope was missing or malformed. Log [ENVELOPE-FALLBACK] and
        // dispatch on the tool's intent.
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
        // See the CANONICAL_REDUCER_INTENTS note at the top of the file.
        preGeneratedSpeechRef.current =
          CANONICAL_REDUCER_INTENTS.has(result.intent.type) ? null : result.speech
        processIntent(result.intent, latestMessage, currentState, stage)
        // Room Planner: fallback path — same room-edit intent gate as the
        // envelope branch above. Covers the case where the envelope shape
        // is missing/malformed but the legacy tool carried a room-edit
        // intent.
        maybeKickRoomPlanner(result.intent.type, latestMessage)
      })()
      // Day-1 latency batch: trimmed from 600→250ms. HeyGen's
      // USER_TRANSCRIPTION fires per finalized utterance; the AbortController
      // above already supersedes any second utterance arriving inside the
      // window, so we can shorten the coalescing wait without risking
      // duplicate orchestrate calls.
    }, 250)

    // Note: `profile` and `derivedProfile` are intentionally NOT in this deps
    // array. They churn constantly during a session (ProfileSync updates,
    // regex extractor updates per transcription) — every churn re-runs this
    // effect and would prematurely fire the cancellation/cleanup on the
    // previous run, silently killing legitimate in-flight orchestrate calls.
    // We read the freshest profile/derivedProfile via profileRef.current /
    // derivedProfileRef.current at call time inside the IIFE instead.
  }, [userMessages, dispatch, trackQuestion, trackRequirement, processIntent, rooms, interrupt, repeat, maybeKickRoomPlanner, lastUserSpeakEndedAtRef])

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
    // Unified-turn cleanup on stage transition: any pending debounce timer
    // or in-flight orchestrate from the previous stage should not land in
    // the new stage. Also drop any leftover preGeneratedSpeechRef so the
    // next SPEAK_INTENT doesn't speak stale cross-stage LLM speech.
    killCurrentUnifiedTurn("stage-change")
    preGeneratedSpeechRef.current = null
  }, [journeyStage, abortStaleProfileOrchestrate, killCurrentUnifiedTurn])

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
      // Same for the unified turn — clear any pending timer and abort any
      // in-flight fetch so unmounted pages don't keep the orchestrate
      // roundtrip alive.
      killCurrentUnifiedTurn("unmount")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const onUnitSelectedUE5 = useCallback(
    (payload: { roomName: string; description?: string; price?: string; level?: string }) => {
      const selectedRoomName = payload.roomName.trim()
      const selectedRoom = rooms.find((r) => r.name.trim().toLowerCase() === selectedRoomName.toLowerCase())
      currentRoomIdRef.current = selectedRoom?.id ?? null
      currentRoomNameRef.current = selectedRoom?.name ?? selectedRoomName
      if (selectedRoom) {
        trackRoomExplored(selectedRoom.id, selectedRoom.name)
      }
      dispatch({
        type: "UNIT_SELECTED_UE5",
        roomName: payload.roomName,
      })
      options.onUnitSelected?.(payload.roomName)
    },
    [dispatch, options, rooms, trackRoomExplored],
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
        visitedAmenities: visitedAmenityNamesRef.current,
        allAmenities: amenitiesRef.current.map((a): AmenityRef => ({ id: a.id, name: a.name, scene: a.scene })),
      })
    },
    [dispatch, stopExplorationTimer, trackAmenityExplored, startAmenityTimer],
  )

  const onNavigateBack = useCallback(() => {
    stopExplorationTimer()
    dispatch({ type: "USER_INTENT", intent: { type: "BACK" } })
  }, [dispatch, stopExplorationTimer])

  return {
    dispatch,
    getInternalState,
    onHotelSelected,
    onUnitSelectedUE5,
    onAmenityCardTapped,
    onNavigateBack,
  }
}
