"use client"

// ---------------------------------------------------------------------------
// Omnam unified store (Phase 6 of /home refactor).
//
// Collapses `UserProfileContext`, `AppContext`, and the ad-hoc
// `useJourney`-internal `stateRef` into a single React-driven store. Consumer
// call-sites continue to work via thin shims exported from `lib/context.tsx`
// and `lib/store.tsx`; this module is the new source of truth.
//
// Design choices:
//   • A plain `useReducer` drives React re-renders. Its reducer is a wrapper
//     that delegates profile/app actions to hand-written cases, journey
//     actions to `journeyReducer`, and a special JOURNEY_STATE_OVERRIDE to
//     replace the pre-Phase-6 imperative `stateRef.current = {...}` writes.
//   • Effects produced by `journeyReducer` are captured on a per-Provider ref
//     (`effectQueueRef`). The `dispatch` wrapper runs the reducer itself (not
//     `reactDispatch`) against a live mirror ref to collect effects
//     synchronously, THEN calls `reactDispatch(action)` to schedule React's
//     re-render. This avoids interactions with React's StrictMode
//     double-invocation of reducers and the automatic bail-out behavior when
//     state is identical.
//   • A live `stateRef` mirrors the latest state so `useJourney` can read the
//     freshest slice synchronously without depending on closures or timing.
//
// Nothing in /home-v2 imports from this file directly — it uses the compat
// shims in `lib/context.tsx` / `lib/store.tsx`. Those shims forward to this
// store under the hood, so both paths share the same state when rendered.
// ---------------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react"
import type { UserProfile, GuestComposition, JourneyStage } from "@/lib/context"
import { journeyReducer, INITIAL_JOURNEY_STATE } from "@/lib/orchestrator/journey-machine"
import type { JourneyState, JourneyAction, JourneyEffect } from "@/lib/orchestrator/types"

// ---------------------------------------------------------------------------
// AppState — mirror of the old AppContext shape in lib/store.tsx. Kept verbatim
// so consumers (home page, home-v2, Firebase persistence) see the same fields.
// ---------------------------------------------------------------------------

export type AppSearchCriteria = {
  destination: string
  checkIn: Date | null
  checkOut: Date | null
  adults: number
  children: number
  rooms: number
}

export type AppBooking = {
  id: string
  hotelName: string
  roomName: string
  checkIn: Date
  checkOut: Date
  guests: number
  totalPrice: number
  createdAt: Date
}

export type AppState = {
  searchCriteria: AppSearchCriteria
  selectedHotel: string | null
  bookings: AppBooking[]
  isLoading: boolean
}

// ---------------------------------------------------------------------------
// Unified store state
// ---------------------------------------------------------------------------

export type OmnamStoreState = {
  profile: UserProfile
  journeyStage: JourneyStage
  app: AppState
  journey: JourneyState
}

// ---------------------------------------------------------------------------
// Action types — union of profile, app, and journey actions. Journey actions
// are passed through untouched; profile/app have their own discriminants.
// ---------------------------------------------------------------------------

export type ProfileAction =
  | { type: "UPDATE_PROFILE"; updates: Partial<UserProfile> }
  | { type: "RESET_PROFILE" }
  | { type: "SET_JOURNEY_STAGE"; stage: JourneyStage }

export type AppAction =
  | { type: "UPDATE_SEARCH_CRITERIA"; criteria: Partial<AppSearchCriteria> }
  | { type: "SELECT_HOTEL"; slug: string }
  | { type: "ADD_BOOKING"; booking: Omit<AppBooking, "id" | "createdAt"> }
  | { type: "SET_LOADING"; loading: boolean }

/**
 * Imperative override used to replace the pre-Phase-6 direct
 * `stateRef.current = {...}` writes in `useJourney`. Does not run the journey
 * reducer — it simply pins the internal JourneyState to the provided value.
 * Use sparingly; reducer actions are preferred.
 */
export type JourneyOverrideAction = { type: "JOURNEY_STATE_OVERRIDE"; state: JourneyState }

export type OmnamStoreAction =
  | ProfileAction
  | AppAction
  | JourneyAction
  | JourneyOverrideAction

// ---------------------------------------------------------------------------
// Profile merge — copied from lib/context.tsx so the deep-merge semantics for
// guestComposition and the familySize derivation are preserved bit-for-bit.
// ---------------------------------------------------------------------------

const createEmptyProfile = (): UserProfile => ({
  interests: [],
  startDate: null,
  endDate: null,
})

const mergeUnique = (current: string[], incoming?: string[]): string[] => {
  if (!incoming) return current
  const unique = new Set([...current, ...incoming.filter(Boolean)])
  return Array.from(unique)
}

function mergeProfile(prev: UserProfile, updates: Partial<UserProfile>): UserProfile {
  // guestComposition must deep-merge — a partial update like
  // { childrenAges: [10, 15] } would otherwise wipe adults/children from
  // prior turns. Same applies if a future turn sends just { adults: 3 }.
  const mergedGuestComposition = updates.guestComposition
    ? { ...(prev.guestComposition ?? {}), ...updates.guestComposition }
    : prev.guestComposition
  // Drop familySize from incoming updates if it's NaN (caller computed it from
  // an incomplete guestComposition). We'll recompute below when we have the
  // full merged composition.
  const { familySize: incomingFamilySize, ...restUpdates } = updates
  const safeFamilySize =
    typeof incomingFamilySize === "number" && Number.isFinite(incomingFamilySize)
      ? incomingFamilySize
      : mergedGuestComposition &&
          typeof mergedGuestComposition.adults === "number" &&
          typeof mergedGuestComposition.children === "number"
        ? mergedGuestComposition.adults + mergedGuestComposition.children
        : prev.familySize
  return {
    ...prev,
    ...restUpdates,
    guestComposition: mergedGuestComposition as GuestComposition | undefined,
    familySize: safeFamilySize,
    interests: mergeUnique(prev.interests, updates.interests),
    dietaryRestrictions: mergeUnique(prev.dietaryRestrictions ?? [], updates.dietaryRestrictions),
    accessibilityNeeds: mergeUnique(prev.accessibilityNeeds ?? [], updates.accessibilityNeeds),
    amenityPriorities: mergeUnique(prev.amenityPriorities ?? [], updates.amenityPriorities),
  }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_APP_STATE: AppState = {
  searchCriteria: {
    destination: "",
    checkIn: null,
    checkOut: null,
    adults: 2,
    children: 0,
    rooms: 1,
  },
  selectedHotel: null,
  bookings: [],
  isLoading: false,
}

export const INITIAL_OMNAM_STORE_STATE: OmnamStoreState = {
  profile: createEmptyProfile(),
  journeyStage: "PROFILE_COLLECTION",
  app: INITIAL_APP_STATE,
  journey: INITIAL_JOURNEY_STATE,
}

// ---------------------------------------------------------------------------
// Action discriminant helpers
// ---------------------------------------------------------------------------

const PROFILE_ACTION_TYPES = new Set(["UPDATE_PROFILE", "RESET_PROFILE", "SET_JOURNEY_STAGE"])
const APP_ACTION_TYPES = new Set([
  "UPDATE_SEARCH_CRITERIA",
  "SELECT_HOTEL",
  "ADD_BOOKING",
  "SET_LOADING",
])

function isProfileAction(a: OmnamStoreAction): a is ProfileAction {
  return PROFILE_ACTION_TYPES.has(a.type)
}
function isAppAction(a: OmnamStoreAction): a is AppAction {
  return APP_ACTION_TYPES.has(a.type)
}
function isJourneyOverride(a: OmnamStoreAction): a is JourneyOverrideAction {
  return a.type === "JOURNEY_STATE_OVERRIDE"
}

// ---------------------------------------------------------------------------
// Root reducer — pure. Effects from the journey sub-reducer are discarded
// here (they're collected by the `dispatch` wrapper via a parallel call
// against the live mirror state).
// ---------------------------------------------------------------------------

function omnamRootReducer(
  state: OmnamStoreState,
  action: OmnamStoreAction,
): OmnamStoreState {
  // Profile slice
  if (isProfileAction(action)) {
    switch (action.type) {
      case "UPDATE_PROFILE":
        return { ...state, profile: mergeProfile(state.profile, action.updates) }
      case "RESET_PROFILE":
        return { ...state, profile: createEmptyProfile() }
      case "SET_JOURNEY_STAGE":
        return { ...state, journeyStage: action.stage }
    }
  }

  // App slice
  if (isAppAction(action)) {
    switch (action.type) {
      case "UPDATE_SEARCH_CRITERIA":
        return {
          ...state,
          app: {
            ...state.app,
            searchCriteria: { ...state.app.searchCriteria, ...action.criteria },
          },
        }
      case "SELECT_HOTEL":
        return { ...state, app: { ...state.app, selectedHotel: action.slug } }
      case "ADD_BOOKING": {
        const newBooking: AppBooking = {
          ...action.booking,
          id: Math.random().toString(36).slice(2, 11),
          createdAt: new Date(),
        }
        return {
          ...state,
          app: { ...state.app, bookings: [...state.app.bookings, newBooking] },
        }
      }
      case "SET_LOADING":
        return { ...state, app: { ...state.app, isLoading: action.loading } }
    }
  }

  // Journey-state override (replaces old `stateRef.current = {...}` writes)
  if (isJourneyOverride(action)) {
    return { ...state, journey: action.state }
  }

  // Journey action — delegate to the pure journey reducer. Effects are
  // discarded in this reducer body (the `dispatch` wrapper runs the journey
  // reducer separately against the live mirror so it can collect them).
  const { nextState } = journeyReducer(state.journey, action)
  return { ...state, journey: nextState }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Dispatch return contract:
 *   • Journey actions → returns the reducer's effect list.
 *   • Profile / App / Override actions → returns [].
 */
export type OmnamDispatch = (action: OmnamStoreAction) => JourneyEffect[]

export type OmnamStoreContextValue = {
  state: OmnamStoreState
  dispatch: OmnamDispatch
  /**
   * Live mirror of `state`. Updated synchronously inside every `dispatch`
   * call so callers can read the freshest state from async callbacks or
   * stale closures without depending on React render timing.
   */
  stateRef: { readonly current: OmnamStoreState }
}

const OmnamStoreContext = createContext<OmnamStoreContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function OmnamStoreProvider({ children }: { children: ReactNode }) {
  const [state, reactDispatch] = useReducer(omnamRootReducer, INITIAL_OMNAM_STORE_STATE)

  // Mirror ref initialized to the first committed state. Kept in sync
  // imperatively inside `dispatch` (see below) so synchronous consumers
  // observe writes immediately — before React's next render.
  const stateRef = useRef<OmnamStoreState>(state)

  const dispatch = useCallback<OmnamDispatch>((action) => {
    // Compute the next state + effect list synchronously against the mirror.
    // This is cheap because all reducers here are pure; it also matches what
    // React's next render will commit (the same pure reducer, same inputs).
    //
    // We derive effects only for journey actions; for profile/app/override
    // actions the effect list is always empty.
    let effects: JourneyEffect[] = []
    if (
      !isProfileAction(action) &&
      !isAppAction(action) &&
      !isJourneyOverride(action)
    ) {
      // Journey action — run journeyReducer directly to capture effects.
      const journeyResult = journeyReducer(stateRef.current.journey, action)
      effects = journeyResult.effects
    }

    // Compute the full next state via the root reducer and update the mirror.
    const nextState = omnamRootReducer(stateRef.current, action)
    stateRef.current = nextState

    // Schedule the React re-render. The reducer we hand React is pure and
    // deterministic given the same inputs, so React will converge on the
    // same `nextState` we just stamped into the mirror. If StrictMode
    // double-invokes the reducer in dev, the mirror stays untouched (that
    // runs inside `reactDispatch`, not here), and effects aren't duplicated.
    reactDispatch(action)

    return effects
  }, [])

  const value = useMemo<OmnamStoreContextValue>(
    () => ({ state, dispatch, stateRef }),
    [state, dispatch],
  )

  return <OmnamStoreContext.Provider value={value}>{children}</OmnamStoreContext.Provider>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOmnamStore(): OmnamStoreContextValue {
  const ctx = useContext(OmnamStoreContext)
  if (!ctx) {
    throw new Error("useOmnamStore must be used within an OmnamStoreProvider")
  }
  return ctx
}
