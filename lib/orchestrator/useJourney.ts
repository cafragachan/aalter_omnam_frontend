"use client"

import { useCallback, useEffect, useRef } from "react"
import { useUserProfileContext } from "@/lib/context"
import { useOmnamStore } from "@/lib/omnam-store"
import { useAuth } from "@/lib/auth-context"
import { useUserProfile as useHeyGenUserProfile } from "@/lib/liveavatar"
import { useAvatarActions as useHeyGenAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useLiveAvatarContext as useHeyGenLiveAvatarContext } from "@/lib/liveavatar/context"
import { MessageSender } from "@/lib/liveavatar/types"
import type { LiveAvatarSessionMessage } from "@/lib/liveavatar/types"
import type { AvatarDerivedProfile } from "@/lib/liveavatar/useUserProfile"
import { useEventBus, useEventListener } from "@/lib/events"
import { useGuestIntelligence } from "@/lib/guest-intelligence"
import { classifyIntent, classifyAvatarProposal, type UserIntent } from "./intents"
import { classifyIntentLLM } from "./classifyIntentLLM"
import { classifyRoomPlanLLM } from "./classifyRoomPlanLLM"
import type { RoomPlanAction, RoomPlanContext } from "./classifyRoomPlanLLM"
import { generateSpeechLLM } from "./generateSpeechLLM"
import { orchestrateLLM } from "./orchestrateLLM"
import type { SpeechContext } from "./generateSpeechLLM"
import { buildAmenityNarrative, profileCollectionAwaiting } from "./journey-machine"
import { evaluateFastPath, CLIENT_CANNED_SPEECH, type ProfileAwaiting } from "./profileFastPath"
import { useIdleDetection } from "./idle-detection"
import type { JourneyState, JourneyAction, JourneyEffect, AmenityRef } from "./types"
import { logTurn, logEffect, type EffectEntry } from "@/lib/debug"
import {
  getRecommendedAmenity,
  getRecommendedRoomPlan,
  getBudgetRoomPlan,
  getCompactRoomPlan,
  buildExplicitRoomPlan,
  parseExplicitRoomRequests,
  matchRoomByName,
  type Amenity,
  type HotelCatalog,
  type Room,
  type RoomPlan,
} from "@/lib/hotel-data"

// ---------------------------------------------------------------------------
// Intents the regex classifier handles with high confidence — no LLM needed.
// ---------------------------------------------------------------------------
const HIGH_CONFIDENCE_INTENTS: ReadonlySet<string> = new Set([
  "BACK", "INTERIOR", "EXTERIOR", "ROOMS", "AMENITIES", "LOCATION",
  "HOTEL_EXPLORE", "BOOK", "TRAVEL_TO_HOTEL", "OTHER_OPTIONS",
  "ROOM_PLAN_CHEAPER", "ROOM_PLAN_COMPACT", "ROOM_TOGETHER",
  "ROOM_SEPARATE", "ROOM_AUTO", "DOWNLOAD_DATA", "AMENITY_BY_NAME",
])

// ---------------------------------------------------------------------------
// Lightweight guard — avoids calling the room-plan LLM on every utterance.
// Intentionally broad: false positives are cheap (LLM returns no_room_change).
// ---------------------------------------------------------------------------
const ROOM_PLANNING_RE = /\b(cheap|budget|afford|expensive|price|cost|\$|dollar|room|suite|penthouse|loft|standard|mountain|lake|view|together|separate|own room|fit|compact|fewer|less|one room|two room|nanny|kids|children|split|share)\b/i

// ---------------------------------------------------------------------------
// Multi-room composition guard — messages like "2 standard rooms and 1 loft"
// should skip single-room matching and fall through to the room plan LLM.
// ---------------------------------------------------------------------------
const MULTI_ROOM_RE = /\d+\s*(?:standard|loft|penthouse|mountain|lake|room|suite)/i

// Aliases for amenity keywords the user might say that aren't literal amenity
// names. "Lounge" specifically maps to lobby inside the hotel — the only
// "lounge" we exit to is the *virtual* lounge, which is caught earlier by
// RETURN_TO_LOUNGE_RE (requires the literal word "virtual").
const AMENITY_ALIASES: Record<string, string> = {
  lounge: "lobby",
  reception: "lobby",
  entrance: "lobby",
}

function isRoomPlanningMessage(message: string): boolean {
  return ROOM_PLANNING_RE.test(message)
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

/**
 * Shape of the avatar-backend hooks useJourney depends on. Structural
 * subset shared by the legacy `@/lib/liveavatar` hooks and the new
 * `@/lib/livekit` hooks (Stage 3 mirrored the shape byte-for-byte).
 */
export type UseJourneyAvatarHooks = {
  useContext: () => { messages: LiveAvatarSessionMessage[]; isAvatarTalking: boolean; isUserTalking: boolean }
  useActions: () => {
    interrupt: () => unknown
    repeat: (text: string) => Promise<unknown>
    startListening: () => unknown
    stopListening: () => unknown
    message: (text: string) => void
  }
  useProfile: () => {
    profile: AvatarDerivedProfile
    userMessages: { message: string; timestamp: number }[]
    triggerAIExtraction: () => Promise<void>
    isExtracting: boolean
    isExtractionPending: boolean
    aiAvailable: boolean
  }
}

type UseJourneyOptions = {
  onOpenPanel: (panel: "rooms" | "amenities" | "location") => void
  onClosePanels: () => void
  onUE5Command: (command: string, value: unknown) => void
  onResetToDefault: () => void
  onFadeTransition: () => void
  onSelectHotel: (slug: string) => void
  onUnitSelected?: (roomName: string) => void
  /** Callback to update the displayed room plan (dynamic adjustments) */
  onUpdateRoomPlan?: (plan: RoomPlan) => void
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
   * When true, ambiguous intents (UNKNOWN, AFFIRMATIVE, NEGATIVE, AMENITY_BY_NAME)
   * are re-classified via the LLM API route before dispatching. High-confidence
   * regex results bypass the LLM entirely for zero-latency response.
   * Default: false (regex-only, current behavior). Only `/home` passes true.
   */
  enableLLMClassifier?: boolean
  /**
   * When true, room plan adjustment intents in HOTEL_EXPLORATION / ROOM_SELECTED
   * are re-classified via the LLM room-plan classifier for structured parameter
   * extraction. Falls back to existing heuristic logic on failure.
   * Default: false. Only `/home` passes true.
   */
  enableLLMRoomPlanning?: boolean
  /**
   * When true, SPEAK effects and direct repeat() calls generate contextual
   * speech via the LLM API route instead of using hardcoded strings.
   * Hardcoded text becomes the fallback on failure. Default: false.
   * Only `/home` passes true.
   */
  enableLLMSpeech?: boolean
  /**
   * When true, user messages are classified via a single consolidated
   * /api/orchestrate call that returns intent + room plan action + speech
   * in one round-trip. Supersedes the three individual LLM flags when set.
   * Default: false. Only `/home` passes true.
   *
   * @deprecated Phase 0 rename — prefer `useUnifiedOrchestrator`. Both
   * accepted for now; new name wins when both are set.
   */
  enableLLMOrchestrate?: boolean
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
   * Stage 5 (LiveKit path): when provided, SPEAK effects are routed
   * through this callback instead of interrupt()+repeat() on the avatar
   * session. Legacy /home does not pass this — default behavior is
   * preserved exactly. /home-v2 passes a function that forwards the
   * text as a `narration_nudge` on the LiveKit data channel.
   */
  onSpeak?: (text: string) => void
  /**
   * Stage 5 (LiveKit path): pluggable avatar-backend hooks. When
   * omitted, defaults to `@/lib/liveavatar` (HeyGen) — legacy /home's
   * behavior is byte-for-byte unchanged. /home-v2 passes the matching
   * `@/lib/livekit` hooks so the same reducer runs against the LiveKit
   * data flow (messages, repeat/interrupt, profile extraction) without
   * touching useJourney's imports.
   *
   * This is the seam that lets a single shared orchestrator power both
   * avatar paths. It is mandatory — not just optional — for /home-v2,
   * because the default HeyGen hooks throw when called without a
   * LiveAvatarContextProvider mounted.
   */
  avatarHooks?: UseJourneyAvatarHooks
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
  //   3. Deprecated alias options.enableLLMOrchestrate (boolean → "on" / "off")
  //   4. Default "off" for full backward-compat with callers that pass nothing.
  //
  // Consumers downstream can read either the tri-state (for the shadow-mode
  // branch) or the derived boolean `isUnifiedOn` (for the existing truthy
  // checks sprinkled through the file — fast-path gating, intent routing,
  // etc.). Keeping both avoids churn on dozens of unrelated code paths.
  const unifiedRaw = options.useUnifiedOrchestrator ?? options.enableLLMOrchestrate
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

  // Resolve avatar-backend hooks. Default: legacy HeyGen hooks. /home-v2
  // passes the `@/lib/livekit` equivalents via options.avatarHooks. The
  // resolved functions are stable across renders because options.avatarHooks
  // is fixed for the component's lifetime, so Rules of Hooks is satisfied.
  const useAvatarContextFn = options.avatarHooks?.useContext ?? useHeyGenLiveAvatarContext
  const useUserProfileFn = options.avatarHooks?.useProfile ?? useHeyGenUserProfile
  const useAvatarActionsFn = options.avatarHooks?.useActions ?? (() => useHeyGenAvatarActions("FULL"))

  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const { userProfile: authIdentity, returningUserData } = useAuth()
  const { profile: derivedProfile, isExtractionPending, userMessages } = useUserProfileFn()
  const { messages: allMessages } = useAvatarContextFn()
  const { repeat, interrupt, stopListening } = useAvatarActionsFn()
  const eventBus = useEventBus()
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
  const lastAvatarMessageCountRef = useRef<number | null>(null)

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

  // --- LLM speech generation helpers ---
  const buildSpeechContext = useCallback((
    eventType?: string,
    lastUserMessage?: string,
  ): SpeechContext => ({
    journeyStage: stateRef.current.stage,
    eventType,
    guestFirstName: profile.firstName,
    travelPurpose: profile.travelPurpose ?? derivedProfile.travelPurpose,
    guestComposition: profile.guestComposition ?? derivedProfile.guestComposition,
    interests: profile.interests,
    lastUserMessage,
  }), [profile, derivedProfile])

  const speakWithLLM = useCallback(async (
    fallbackText: string,
    context: SpeechContext,
  ) => {
    interrupt()
    if (!options.enableLLMSpeech) {
      repeat(fallbackText).catch(() => undefined)
      return
    }
    const generated = await generateSpeechLLM(fallbackText, context)
    repeat(generated ?? fallbackText).catch(() => undefined)
  }, [interrupt, repeat, options.enableLLMSpeech])

  /** Check preGeneratedSpeechRef first, fall back to speakWithLLM */
  const speakResolved = useCallback((fallbackText: string, context: SpeechContext) => {
    if (preGeneratedSpeechRef.current !== null) {
      const preGenerated = preGeneratedSpeechRef.current
      preGeneratedSpeechRef.current = null
      interrupt()
      repeat(preGenerated).catch(() => undefined)
      return
    }
    void speakWithLLM(fallbackText, context)
  }, [interrupt, repeat, speakWithLLM])

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
      logEffect({ type: effect.type, params: params as Record<string, unknown>, source })
      switch (effect.type) {
        case "SPEAK":
          if (options.onSpeak) {
            options.onSpeak(effect.text)
          } else if (preGeneratedSpeechRef.current !== null) {
            const preGenerated = preGeneratedSpeechRef.current
            preGeneratedSpeechRef.current = null
            interrupt()
            repeat(preGenerated).catch(() => undefined)
          } else if (options.enableLLMSpeech || useUnifiedOrchestrator) {
            void speakWithLLM(effect.text, buildSpeechContext())
          } else {
            interrupt()
            repeat(effect.text).catch(() => undefined)
          }
          break
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
        case "SET_ROOM_ALLOCATION":
          updateProfile({ roomAllocation: effect.allocation })
          break
        case "UPDATE_ROOM_PLAN":
          options.onUpdateRoomPlan?.(effect.plan)
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
  }, [interrupt, repeat, stopListening, onUE5Command, onOpenPanel, onClosePanels, onFadeTransition, setJourneyStage, onResetToDefault, onSelectHotel, downloadUserData, rooms, setBookingOutcome, options, speakWithLLM, buildSpeechContext])

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
      void speakWithLLM(
        `I don't think we have a ${amenityName} at this property. Would you like to see the rooms, or explore the surrounding area?`,
        buildSpeechContext("AMENITY_NOT_FOUND", amenityName),
      )
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
  }, [amenities, amenityRefs, trackAmenityExplored, startAmenityTimer, getVisitedAmenityNames, speakWithLLM, buildSpeechContext, dispatch])

  /** Handle dynamic room plan adjustments (budget, compact, distribution change) */
  const handlePlanAdjustment = useCallback((
    mode: "budget" | "compact" | "distribution",
    _message: string,
    allocationOverride?: number[],
  ) => {
    const partySize = profile.familySize ?? derivedProfile.partySize
    if (!partySize || rooms.length === 0) return

    let newPlan: RoomPlan | null = null
    let speechText = ""

    if (mode === "budget") {
      newPlan = getBudgetRoomPlan(rooms, partySize, profile.roomAllocation)
      if (newPlan) {
        const summary = newPlan.entries
          .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
          .join(" and ")
        speechText = `Here's a more budget-friendly option: ${summary} at $${newPlan.totalPricePerNight.toLocaleString()} per night. How does that look?`
      }
    } else if (mode === "compact") {
      newPlan = getCompactRoomPlan(rooms, partySize)
      if (newPlan) {
        const roomCount = newPlan.entries.reduce((sum, e) => sum + e.quantity, 0)
        const summary = newPlan.entries
          .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
          .join(" and ")
        speechText = `I've packed your group into ${roomCount} room${roomCount > 1 ? "s" : ""}: ${summary} at $${newPlan.totalPricePerNight.toLocaleString()} per night. What do you think?`
      }
    } else if (mode === "distribution") {
      const allocation = allocationOverride ?? profile.roomAllocation
      newPlan = getRecommendedRoomPlan(
        rooms, partySize, profile.guestComposition, profile.travelPurpose, profile.budgetRange, undefined, allocation,
      )
      if (newPlan) {
        const roomCount = newPlan.entries.reduce((sum, e) => sum + e.quantity, 0)
        const summary = newPlan.entries
          .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
          .join(" and ")
        speechText = `Here's the updated layout: ${summary} — ${roomCount} room${roomCount > 1 ? "s" : ""} at $${newPlan.totalPricePerNight.toLocaleString()} per night.`
      }
    }

    if (newPlan) {
      speakResolved(speechText, buildSpeechContext("PLAN_ADJUSTMENT"))
      executeEffects([{ type: "UPDATE_ROOM_PLAN", plan: newPlan }], "orchestrate")
      // Ensure the rooms panel is open
      if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
        executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }], "orchestrate")
        stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
      }
    }
  }, [profile, derivedProfile, rooms, speakResolved, buildSpeechContext, executeEffects])

  /** Handle explicit room composition from user (e.g., "4 standard rooms and 2 loft suites") */
  const handleExplicitComposition = useCallback((
    requests: { roomId: string; quantity: number }[],
  ) => {
    const partySize = profile.familySize ?? derivedProfile.partySize
    const { plan, warning } = buildExplicitRoomPlan(requests, rooms, partySize)

    if (plan.entries.length === 0) {
      speakResolved(
        "I couldn't quite match those room types. Could you describe the combination you'd like?",
        buildSpeechContext("EXPLICIT_COMPOSITION"),
      )
      return
    }

    const summary = plan.entries
      .map((e) => `${e.quantity} ${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
      .join(" and ")

    let speechText = `Got it — ${summary} at $${plan.totalPricePerNight.toLocaleString()} per night total.`
    if (warning) {
      speechText += ` Just a heads up: ${warning}`
    } else {
      speechText += " How does that look?"
    }

    speakResolved(speechText, buildSpeechContext("EXPLICIT_COMPOSITION"))
    executeEffects([{ type: "UPDATE_ROOM_PLAN", plan }], "orchestrate")

    // Ensure the rooms panel is open
    if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
      executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }], "orchestrate")
      stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
    }
  }, [profile, derivedProfile, rooms, speakResolved, buildSpeechContext, executeEffects])

  /**
   * Execute a structured RoomPlanAction from the LLM room-plan classifier.
   * Returns true if the action was handled, false if the caller should fall
   * back to the existing heuristic path (e.g. no_room_change).
   */
  const executeRoomPlanAction = useCallback((action: RoomPlanAction, _message: string): boolean => {
    if (action.action === "no_room_change") return false

    const partySize = profile.familySize ?? derivedProfile.partySize
    if (!partySize || rooms.length === 0) return false

    if (action.action === "adjust_budget") {
      if (action.params.target_per_night) {
        // LLM extracted a specific budget target — use getRecommendedRoomPlan with budget string
        const budgetStr = `$${action.params.target_per_night}`
        const newPlan = getRecommendedRoomPlan(
          rooms, partySize, profile.guestComposition, profile.travelPurpose, budgetStr, undefined, profile.roomAllocation,
        )
        if (newPlan) {
          const summary = newPlan.entries
            .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
            .join(" and ")
          speakResolved(
            `Here's what I can do close to ${budgetStr} per night: ${summary} at $${newPlan.totalPricePerNight.toLocaleString()} per night. How does that sound?`,
            buildSpeechContext("ADJUST_BUDGET"),
          )
          executeEffects([{ type: "UPDATE_ROOM_PLAN", plan: newPlan }], "orchestrate")
          if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
            executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }], "orchestrate")
            stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
          }
          return true
        }
      }
      // No target or plan failed — fall back to budget mode
      handlePlanAdjustment("budget", _message)
      return true
    }

    if (action.action === "set_room_composition") {
      handleExplicitComposition(action.params.rooms.map((r) => ({ roomId: r.room_id, quantity: r.quantity })))
      return true
    }

    if (action.action === "compact_plan") {
      if (action.params.max_rooms) {
        // LLM extracted a specific constraint — use getCompactRoomPlan and validate
        const newPlan = getCompactRoomPlan(rooms, partySize)
        if (newPlan) {
          const roomCount = newPlan.entries.reduce((sum, e) => sum + e.quantity, 0)
          if (roomCount <= action.params.max_rooms) {
            const summary = newPlan.entries
              .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
              .join(" and ")
            speakResolved(
              `Great news — I can fit your group into ${roomCount} room${roomCount > 1 ? "s" : ""}: ${summary} at $${newPlan.totalPricePerNight.toLocaleString()} per night.`,
              buildSpeechContext("COMPACT_PLAN"),
            )
            executeEffects([{ type: "UPDATE_ROOM_PLAN", plan: newPlan }], "orchestrate")
            if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
              executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }], "orchestrate")
              stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
            }
            return true
          } else {
            speakResolved(
              `I wasn't able to fit everyone into just ${action.params.max_rooms} room${action.params.max_rooms > 1 ? "s" : ""} — the minimum is ${roomCount}. Here's the most compact option I have. What do you think?`,
              buildSpeechContext("COMPACT_PLAN"),
            )
            executeEffects([{ type: "UPDATE_ROOM_PLAN", plan: newPlan }], "orchestrate")
            if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
              executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }], "orchestrate")
              stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
            }
            return true
          }
        }
      }
      // No constraint or plan failed — fall back to compact mode
      handlePlanAdjustment("compact", _message)
      return true
    }

    if (action.action === "set_distribution") {
      updateProfile({ roomAllocation: action.params.allocation })
      handlePlanAdjustment("distribution", _message, action.params.allocation)
      return true
    }

    if (action.action === "recompute_with_preferences") {
      const budgetStr = action.params.budget_range ?? profile.budgetRange
      const distPref = action.params.distribution_preference as import("@/lib/hotel-data").DistributionPreference | undefined
      const newPlan = getRecommendedRoomPlan(
        rooms, partySize, profile.guestComposition, profile.travelPurpose, budgetStr, distPref, profile.roomAllocation,
      )
      if (newPlan) {
        const summary = newPlan.entries
          .map((e) => `${e.quantity > 1 ? `${e.quantity} ` : ""}${e.roomName}${e.quantity > 1 ? " rooms" : ""}`)
          .join(" and ")
        const prefLabel = action.params.room_type_preference ?? "your preferences"
        speakResolved(
          `Based on ${prefLabel}, here's what I'd recommend: ${summary} at $${newPlan.totalPricePerNight.toLocaleString()} per night. How does that look?`,
          buildSpeechContext("RECOMPUTE_PREFERENCES"),
        )
        executeEffects([{ type: "UPDATE_ROOM_PLAN", plan: newPlan }], "orchestrate")
        if (stateRef.current.stage === "HOTEL_EXPLORATION" && stateRef.current.subState !== "panel_open") {
          executeEffects([{ type: "OPEN_PANEL", panel: "rooms" }], "orchestrate")
          stateRef.current = { stage: "HOTEL_EXPLORATION", subState: "panel_open" }
        }
        return true
      }
      return false
    }

    return false
  }, [profile, derivedProfile, rooms, speakResolved, buildSpeechContext, executeEffects, handlePlanAdjustment, handleExplicitComposition, updateProfile])

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
      })()
    },
    [profile, derivedProfile, rooms, allMessages],
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
    hooks: options.avatarHooks ? { useContext: options.avatarHooks.useContext } : undefined,
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

    // --- Intercept room plan adjustment intents ---
    const isRoomContext = currentState.stage === "HOTEL_EXPLORATION" || currentState.stage === "ROOM_SELECTED"

    // Existing heuristic room-plan logic, extracted so both the sync (flag off)
    // and async (LLM fallback) paths share the same code without duplication.
    const roomPlanFallback = () => {
      if (isRoomContext && intent.type === "ROOM_PLAN_CHEAPER") {
        handlePlanAdjustment("budget", latestMessage)
        return
      }

      if (isRoomContext && intent.type === "ROOM_PLAN_COMPACT") {
        handlePlanAdjustment("compact", latestMessage)
        return
      }

      if (isRoomContext && (intent.type === "ROOM_TOGETHER" || intent.type === "ROOM_SEPARATE")) {
        const partySize = profile.familySize ?? derivedProfile.partySize ?? 1
        const newAllocation = intent.type === "ROOM_TOGETHER"
          ? [partySize]
          : Array(partySize).fill(1)
        updateProfile({ roomAllocation: newAllocation })
        handlePlanAdjustment("distribution", latestMessage, newAllocation)
        return
      }

      // Try to parse explicit room composition from the raw message
      if (isRoomContext && (intent.type === "UNKNOWN" || intent.type === "ROOMS")) {
        const explicitRequests = parseExplicitRoomRequests(latestMessage, rooms)
        if (explicitRequests && explicitRequests.length > 0) {
          handleExplicitComposition(explicitRequests)
          return
        }
      }

      dispatch({ type: "USER_INTENT", intent })
    }

    // --- LLM room-plan classification branch ---
    const isRoomPlanIntent = isRoomContext && (
      intent.type === "ROOM_PLAN_CHEAPER" || intent.type === "ROOM_PLAN_COMPACT" ||
      intent.type === "ROOM_TOGETHER" || intent.type === "ROOM_SEPARATE" ||
      intent.type === "UNKNOWN" || intent.type === "ROOMS"
    )

    if (isRoomPlanIntent && !useUnifiedOrchestrator && options.enableLLMRoomPlanning && isRoomPlanningMessage(latestMessage)) {
      const partySize = profile.familySize ?? derivedProfile.partySize
      const roomContext: RoomPlanContext = {
        rooms: rooms.map((r) => ({ id: r.id, name: r.name, occupancy: parseInt(r.occupancy, 10) || 2, price: r.price })),
        partySize: partySize ?? undefined,
        currentPlan: undefined, // caller can extend later if needed
        journeyStage: currentState.stage,
        budgetRange: profile.budgetRange ?? undefined,
        guestComposition: profile.guestComposition ?? undefined,
        travelPurpose: profile.travelPurpose ?? undefined,
      }

      ;(async () => {
        const action = await classifyRoomPlanLLM(latestMessage, roomContext)
        if (!action || action.action === "no_room_change") {
          roomPlanFallback()
          return
        }
        const handled = executeRoomPlanAction(action, latestMessage)
        if (!handled) {
          roomPlanFallback()
        }
      })()
      return // handled (async)
    }

    // Flag off or not a room-plan intent — use existing heuristic path
    roomPlanFallback()
  }, [dispatch, dispatchListAmenities, navigateToAmenityByName, startRoomTimer, stopExplorationTimer, handlePlanAdjustment, handleExplicitComposition, executeRoomPlanAction, profile, derivedProfile, rooms, updateProfile, options.enableLLMRoomPlanning])

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

          if (result.tool === "adjust_room_plan" && result.action.action === "set_distribution") {
            logTurn({
              stage: "PROFILE_COLLECTION",
              latestMessage: profileTurnMessageSlice,
              regexIntent: profileRegexIntent.type,
              llmIntent: "ROOM_PLAN",
              action: { type: "ROOM_PLAN_ACTION", action: result.action.action },
              speech: result.speech,
              latencyMs: profileLatencyMs,
              pathway: "orchestrate",
            })
            const allocation = result.action.params?.allocation
            if (Array.isArray(allocation) && allocation.length > 0 && allocation.every((n) => typeof n === "number" && n > 0)) {
              // Unconditional write — state is idempotent.
              updateProfile({ roomAllocation: allocation })
            }
            prevAwaitingRef.current = freshAwaiting
            if (fastPathAlreadySpoke) {
              logDecisionCompare(
                { type: "ROOM_PLAN_ACTION", action: result.action.action },
                result.decision_envelope,
              )
              return
            }
            if (cancelled) return
            interrupt()
            repeat(result.speech).catch(() => undefined)
            logDecisionCompare(
              { type: "ROOM_PLAN_ACTION", action: result.action.action },
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
      // Multi-room composition detected — skip room selection AND intent classification,
      // go directly to the room plan LLM which handles set_room_composition.
      if (MULTI_ROOM_RE.test(latestMessage) && !useUnifiedOrchestrator && options.enableLLMRoomPlanning) {
        const partySize = profile.familySize ?? derivedProfile.partySize
        const roomContext: RoomPlanContext = {
          rooms: rooms.map((r) => ({ id: r.id, name: r.name, occupancy: parseInt(r.occupancy, 10) || 2, price: r.price })),
          partySize: partySize ?? undefined,
          currentPlan: undefined,
          journeyStage: currentState.stage,
          budgetRange: profile.budgetRange ?? undefined,
          guestComposition: profile.guestComposition ?? undefined,
          travelPurpose: profile.travelPurpose ?? undefined,
        }
        ;(async () => {
          const action = await classifyRoomPlanLLM(latestMessage, roomContext)
          if (action && action.action !== "no_room_change") {
            executeRoomPlanAction(action, latestMessage)
          }
        })()
        return
      }

      // Single room selection — fuzzy match room name
      const matched = matchRoomByName(latestMessage, rooms)
      if (matched) {
        eventBus.emit({
          type: "ROOM_CARD_TAPPED",
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
    // The HIGH_CONFIDENCE_INTENTS short-circuit that used to live here is
    // intentionally removed. In "on" mode, EVERY turn goes through orchestrate
    // and dispatch comes from decision_envelope.action (with regex as fallback
    // when the envelope is missing/malformed). The regex result is forwarded
    // as `regexHint` in the request body.
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
          preGeneratedSpeechRef.current = envelope.speech
          processIntent(fullIntentObject, latestMessage, currentState, stage)
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
          interrupt()
          repeat(result.speech).catch(() => undefined)
          logDecisionCompare({ type: "NO_ACTION" }, result.decision_envelope)
          return
        }

        if (result.tool === "adjust_room_plan") {
          logTurn({
            stage,
            latestMessage: turnMessageSlice,
            regexIntent: regexIntent.type,
            llmIntent: "ROOM_PLAN",
            action: { type: "ROOM_PLAN_ACTION", action: result.action.action },
            speech: result.speech,
            latencyMs,
            pathway: "orchestrate",
          })
          preGeneratedSpeechRef.current = result.speech
          const handled = executeRoomPlanAction(result.action, latestMessage)
          if (!handled) {
            preGeneratedSpeechRef.current = null
            processIntent(regexIntent, latestMessage, currentState, stage)
          }
          logDecisionCompare(
            { type: "ROOM_PLAN_ACTION", action: result.action.action },
            result.decision_envelope,
          )
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
        preGeneratedSpeechRef.current = result.speech
        processIntent(result.intent, latestMessage, currentState, stage)
        logDecisionCompare(
          { type: "USER_INTENT", intent: result.intent.type },
          result.decision_envelope,
        )
      })()
      return () => { cancelled = true }
    }

    // --- Original Phase 1-3 path (enableLLMOrchestrate false) ---

    // Fast-path: high-confidence regex results skip the LLM entirely
    const needsLLM = options.enableLLMClassifier === true
      && !HIGH_CONFIDENCE_INTENTS.has(regexIntent.type)

    if (!needsLLM) {
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
      return
    }

    // Async LLM classification with cancellation guard
    let cancelled = false
    const llmClassifyStart = Date.now()
    ;(async () => {
      const llmIntent = await classifyIntentLLM(latestMessage, currentState)
      const latencyMs = Date.now() - llmClassifyStart
      if (cancelled) return
      const finalIntent = llmIntent ?? regexIntent
      logTurn({
        stage,
        latestMessage: turnMessageSlice,
        regexIntent: regexIntent.type,
        llmIntent: llmIntent?.type ?? null,
        action: { type: "USER_INTENT", intent: finalIntent.type },
        speech: null,
        latencyMs,
        pathway: llmIntent ? "orchestrate" : "fallback",
      })
      processIntent(finalIntent, latestMessage, currentState, stage)
    })()
    return () => { cancelled = true }

    // Genuine effect cleanup for the PROFILE_COLLECTION debounce timer.
    // Reachable only when no branch above returned. Critical: do NOT cancel
    // in-flight orchestrate here — that would kill every legitimate call
    // when a new user message arrives. Cancellation belongs to (a) the
    // profile-change effect in Fix 4 and (b) the in-IIFE `cancelled` flag.
    return () => {
      if (profileMsgDebounceRef.current) {
        clearTimeout(profileMsgDebounceRef.current)
        profileMsgDebounceRef.current = null
      }
    }
    // Note: `profile` and `derivedProfile` are intentionally NOT in this deps
    // array. They churn constantly during a session (ProfileSync updates,
    // regex extractor updates per transcription, /api/extract-profile spam) —
    // every churn re-runs this effect and fires the `cancelled = true`
    // cleanup on the previous run, which silently killed legitimate in-flight
    // orchestrate calls (see Phase 3 on-mode blocker). We read the freshest
    // profile/derivedProfile via profileRef.current / derivedProfileRef.current
    // at call time inside the on-mode IIFE instead.
  }, [userMessages, dispatch, trackQuestion, trackRequirement, processIntent, rooms, eventBus, options.enableLLMClassifier, options.enableLLMRoomPlanning, useUnifiedOrchestrator, useUnifiedOrchestratorMode, profileStageUsesOrchestrate, fireShadowOrchestrate, executeRoomPlanAction, interrupt, repeat])

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

  // --- React to new avatar messages (proposal classification + profile nudges) ---
  useEffect(() => {
    const avatarMessages = allMessages.filter((m) => m.sender === MessageSender.AVATAR)
    // Phase 5: baseline on first run so hydrated avatar turns don't
    // re-trigger proposal classification after refresh.
    if (lastAvatarMessageCountRef.current === null) {
      lastAvatarMessageCountRef.current = avatarMessages.length
      return
    }
    if (avatarMessages.length <= lastAvatarMessageCountRef.current) return
    lastAvatarMessageCountRef.current = avatarMessages.length

    const latestAvatarMessage = avatarMessages[avatarMessages.length - 1]?.message ?? ""
    const currentState = stateRef.current

    // --- Proposal classification (only in stages that use lastProposal) ---
    const stage = currentState.stage
    if (stage !== "HOTEL_EXPLORATION" && stage !== "ROOM_SELECTED" && stage !== "AMENITY_VIEWING") return

    const proposal = classifyAvatarProposal(latestAvatarMessage)
    if (proposal) {
      dispatch({ type: "AVATAR_PROPOSAL", proposal: proposal.proposal, amenityName: proposal.amenityName })
    }
  }, [allMessages, dispatch])

  // --- Announce destination overlay when stage transitions ---
  useEffect(() => {
    if (journeyStage !== "DESTINATION_SELECT") {
      destinationAnnouncedRef.current = false
      return
    }
    if (destinationAnnouncedRef.current) return
    destinationAnnouncedRef.current = true

    const timer = setTimeout(() => {
      void speakWithLLM(
        "Based on what you've told me, I think you'll love these options. Take a look — tap any card to step inside the digital twin.",
        buildSpeechContext("DESTINATION_ANNOUNCEMENT"),
      )
    }, 500)
    return () => clearTimeout(timer)
  }, [journeyStage, speakWithLLM, buildSpeechContext])

  // --- EventBus subscriptions ---

  useEventListener("HOTEL_SELECTED", (event) => {
    dispatch({
      type: "HOTEL_PICKED",
      slug: event.slug,
      hotelName: "",
      location: "",
      description: "",
    })
  })

  useEventListener("ROOM_CARD_TAPPED", (event) => {
    stopExplorationTimer()
    trackRoomExplored(event.roomId)
    currentRoomIdRef.current = event.roomId

    dispatch({
      type: "ROOM_CARD_TAPPED",
      roomName: event.roomName,
      occupancy: event.occupancy,
      roomId: event.roomId,
    })
  })

  useEventListener("UNIT_SELECTED_UE5", (event) => {
    dispatch({
      type: "UNIT_SELECTED_UE5",
      roomName: event.roomName,
    })
    options.onUnitSelected?.(event.roomName)
  })

  useEventListener("AMENITY_CARD_TAPPED", (event) => {
    stopExplorationTimer()
    trackAmenityExplored(event.name)
    startAmenityTimer(event.name)
    dispatch({
      type: "AMENITY_CARD_TAPPED",
      name: event.name,
      scene: event.scene,
      amenityId: event.amenityId,
      visitedAmenities: getVisitedAmenityNames(),
      allAmenities: amenityRefs,
    })
  })

  useEventListener("NAVIGATE_BACK", () => {
    stopExplorationTimer()
    dispatch({ type: "USER_INTENT", intent: { type: "BACK" } })
  })

  return { dispatch, getInternalState }
}
