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
// Consumers reach this via the compat shims in `lib/context.tsx` /
// `lib/store.tsx`, which forward to this store under the hood.
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
import type { UserProfile, GuestComposition } from "@/lib/context"
import { rooms as ALL_ROOMS } from "@/lib/hotel-data"
import {
  EMPTY_SELECTION, type UnitInventoryEntry, type UnitSelectionState, type CapacityMap,
  reconcileToPlan, tapUnit, deselectUnit, setActiveUnit, inventoryById, computeSelectionTotals,
} from "@/lib/selection"

// ---------------------------------------------------------------------------
// AppState — mirror of the old AppContext shape in lib/store.tsx. Kept verbatim
// so consumers (home page, Firebase persistence) see the same fields.
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

// ---------------------------------------------------------------------------
// Room Plan — single source of truth for the room plan displayed in the rooms
// panel. Written by two paths: the realtime brain's `propose_room_plan` tool
// (via the dispatcher's `setRoomPlan` hook) and the guest's RoomsPanel card
// edits. `null` means no plan has landed yet; RoomsPanel falls back to its
// static catalog render.
// ---------------------------------------------------------------------------
export type CurrentRoomPlan = {
  rooms: Array<{ roomId: string; quantity: number }>
  totalPerNight: number
  capacity: number
  /**
   * Origin of the current plan. `'planner'` means Ava proposed it via the
   * `propose_room_plan` tool; `'user'` means the guest edited it through the
   * RoomsPanel cards. The reducer recomputes totals/capacity from the static
   * catalog on user edits.
   */
  source: "planner" | "user"
}

export type OmnamStoreState = {
  profile: UserProfile
  app: AppState
  currentRoomPlan: CurrentRoomPlan | null
  /** Full physical-unit inventory pushed by UE5 (empty until the scene reports). */
  unitInventory: UnitInventoryEntry[]
  /** Per-type FIFO selection buckets + the single focused unit. Reconciled
   *  against the plan capacities whenever the plan or inventory changes. */
  unitSelection: UnitSelectionState
}

// ---------------------------------------------------------------------------
// Action types — union of profile, app, and journey actions. Journey actions
// are passed through untouched; profile/app have their own discriminants.
// ---------------------------------------------------------------------------

export type ProfileAction =
  | { type: "UPDATE_PROFILE"; updates: Partial<UserProfile> }
  | { type: "RESET_PROFILE" }

export type AppAction =
  | { type: "UPDATE_SEARCH_CRITERIA"; criteria: Partial<AppSearchCriteria> }
  | { type: "SELECT_HOTEL"; slug: string }
  | { type: "ADD_BOOKING"; booking: Omit<AppBooking, "id" | "createdAt"> }
  | { type: "SET_LOADING"; loading: boolean }

export type RoomPlanAction =
  | { type: "SET_ROOM_PLAN"; plan: CurrentRoomPlan }
  /**
   * User-initiated mutation of the current room plan from the RoomsPanel UI.
   * Three variants:
   *   • `add` — insert the room with quantity 1 (no-op if already present).
   *   • `setQuantity` — change the quantity of an existing entry. quantity ≤ 0 removes it.
   *   • `remove` — drop the entry entirely.
   * The reducer recomputes `totalPerNight` / `capacity` from the static room
   * catalog and tags the resulting plan as `source: 'user'`. If the edit
   * empties the plan, `currentRoomPlan` is reset to `null` (which re-enables
   * the panel-open re-plan trigger).
   */
  | {
      type: "EDIT_ROOM_PLAN"
      edit:
        | { kind: "add"; roomId: string }
        | { kind: "setQuantity"; roomId: string; quantity: number }
        | { kind: "remove"; roomId: string }
    }

export type SelectionAction =
  | { type: "SET_UNIT_INVENTORY"; units: UnitInventoryEntry[] }
  | { type: "TAP_UNIT"; unitId: number }          // from UE5 tap: focus + select-if-new
  | { type: "DESELECT_UNIT"; unitId: number }     // explicit removal
  | { type: "SET_ACTIVE_UNIT"; unitId: number }   // focus only (view_unit / AI)
  | { type: "AI_SELECT_UNITS"; unitIds: number[] } // AI multi-pick

export type OmnamStoreAction =
  | ProfileAction
  | AppAction
  | RoomPlanAction
  | SelectionAction

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
  app: INITIAL_APP_STATE,
  currentRoomPlan: null,
  unitInventory: [],
  unitSelection: EMPTY_SELECTION,
}

// ---------------------------------------------------------------------------
// Action discriminant helpers
// ---------------------------------------------------------------------------

const PROFILE_ACTION_TYPES = new Set(["UPDATE_PROFILE", "RESET_PROFILE"])
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
function isRoomPlanAction(a: OmnamStoreAction): a is RoomPlanAction {
  return a.type === "SET_ROOM_PLAN" || a.type === "EDIT_ROOM_PLAN"
}
const SELECTION_ACTION_TYPES = new Set([
  "SET_UNIT_INVENTORY",
  "TAP_UNIT",
  "DESELECT_UNIT",
  "SET_ACTIVE_UNIT",
  "AI_SELECT_UNITS",
])
function isSelectionAction(a: OmnamStoreAction): a is SelectionAction {
  return SELECTION_ACTION_TYPES.has(a.type)
}

// Bucket capacities for the selection model are derived from the plan's
// per-type quantities (a type appearing twice in the plan sums its quantities).
function capacitiesOf(plan: CurrentRoomPlan | null): CapacityMap {
  const caps: CapacityMap = {}
  for (const e of plan?.rooms ?? []) caps[e.roomId] = (caps[e.roomId] ?? 0) + e.quantity
  return caps
}

// Recompute totals from a list of plan entries by reading the static room
// catalog. Pure — used by the EDIT_ROOM_PLAN reducer branch. Unknown roomIds
// (catalog drift) are silently dropped: the planner never invents IDs and the
// UI only dispatches IDs from the rendered list, so this is defensive.
function recomputePlanTotals(
  entries: Array<{ roomId: string; quantity: number }>,
): { totalPerNight: number; capacity: number } {
  let totalPerNight = 0
  let capacity = 0
  for (const entry of entries) {
    const room = ALL_ROOMS.find((r) => r.id === entry.roomId)
    if (!room) continue
    const occ = parseInt(room.occupancy, 10) || 0
    totalPerNight += room.price * entry.quantity
    capacity += occ * entry.quantity
  }
  return { totalPerNight, capacity }
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

  // Room planner (Phase 1) — additive, writes only the plan slice. Both branches
  // compute a `nextPlan` (possibly null), then run the SHARED reconcile tail below
  // so selection always tracks the plan capacities (and totals reflect per-unit
  // pricing once inventory exists).
  if (isRoomPlanAction(action)) {
    let nextPlan: CurrentRoomPlan | null

    if (action.type === "SET_ROOM_PLAN") {
      nextPlan = action.plan
    } else {
      // EDIT_ROOM_PLAN — user-driven edit from the RoomsPanel cards.
      const prevEntries = state.currentRoomPlan?.rooms ?? []
      let nextEntries: Array<{ roomId: string; quantity: number }>

      // Hoist `action.edit` into a local const inside each case so TypeScript's
      // discriminant narrowing carries through into the `.map()` / `.filter()`
      // closures below.
      const edit = action.edit
      switch (edit.kind) {
        case "add": {
          if (prevEntries.some((e) => e.roomId === edit.roomId)) {
            // Already in plan — leave alone (caller can use setQuantity to bump).
            nextEntries = prevEntries
          } else {
            nextEntries = [...prevEntries, { roomId: edit.roomId, quantity: 1 }]
          }
          break
        }
        case "setQuantity": {
          if (edit.quantity <= 0) {
            nextEntries = prevEntries.filter((e) => e.roomId !== edit.roomId)
          } else {
            nextEntries = prevEntries.map((e) =>
              e.roomId === edit.roomId ? { ...e, quantity: edit.quantity } : e,
            )
          }
          break
        }
        case "remove": {
          nextEntries = prevEntries.filter((e) => e.roomId !== edit.roomId)
          break
        }
      }

      if (nextEntries.length === 0) {
        // Empty plan → null. This re-enables the panel-open planner call so a
        // guest who clears all rooms gets a fresh suggestion next time the
        // panel reopens. capacitiesOf(null) then clears all buckets below.
        nextPlan = null
      } else {
        const { totalPerNight, capacity } = recomputePlanTotals(nextEntries)
        nextPlan = { rooms: nextEntries, totalPerNight, capacity, source: "user" }
      }
    }

    // Shared tail: reconcile selection to the new plan, then (when inventory is
    // present) override the catalog totals with per-unit pricing.
    const nextSelection = reconcileToPlan(
      state.unitSelection, capacitiesOf(nextPlan), state.unitInventory,
    )
    const planWithTotals =
      nextPlan && state.unitInventory.length
        ? { ...nextPlan, ...computeSelectionTotals(nextPlan.rooms, nextSelection, inventoryById(state.unitInventory)) }
        : nextPlan
    return { ...state, currentRoomPlan: planWithTotals, unitSelection: nextSelection }
  }

  // Selection slice — inventory ingest + the three selection input sources
  // (UE5 taps, AI picks, explicit deselect/focus). All routes funnel through the
  // pure helpers in lib/selection.ts so the bucket/FIFO/focus rules stay identical.
  if (isSelectionAction(action)) {
    switch (action.type) {
      case "SET_UNIT_INVENTORY": {
        const sel = reconcileToPlan(state.unitSelection, capacitiesOf(state.currentRoomPlan), action.units)
        const plan =
          state.currentRoomPlan && action.units.length
            ? { ...state.currentRoomPlan, ...computeSelectionTotals(state.currentRoomPlan.rooms, sel, inventoryById(action.units)) }
            : state.currentRoomPlan
        return { ...state, unitInventory: action.units, unitSelection: sel, currentRoomPlan: plan }
      }
      case "TAP_UNIT": {
        const u = inventoryById(state.unitInventory).get(action.unitId)
        if (!u) return state                          // unknown unit → ignore
        if (!u.available) return state                // never select an unavailable unit
        const caps = capacitiesOf(state.currentRoomPlan)
        // Tap on a type NOT in Ava's recommended plan → FOCUS-ONLY: let the guest
        // view that unit, but never silently rewrite the plan/panel (that churned
        // the recommendation and mis-fired the "guest edited the plan" feedback).
        // To add a new room type, Ava calls propose_room_plan.
        if (!caps[u.roomTypeId]) {
          return { ...state, unitSelection: setActiveUnit(state.unitSelection, u.id) }
        }
        const sel0 = reconcileToPlan(state.unitSelection, caps, state.unitInventory)
        const sel = tapUnit(sel0, u.id, u.roomTypeId, caps[u.roomTypeId])
        const planWithTotals =
          state.currentRoomPlan && state.unitInventory.length
            ? { ...state.currentRoomPlan, ...computeSelectionTotals(state.currentRoomPlan.rooms, sel, inventoryById(state.unitInventory)) }
            : state.currentRoomPlan
        return { ...state, currentRoomPlan: planWithTotals, unitSelection: sel }
      }
      case "DESELECT_UNIT": {
        const u = inventoryById(state.unitInventory).get(action.unitId)
        if (!u) return state
        return { ...state, unitSelection: deselectUnit(state.unitSelection, u.id, u.roomTypeId) }
      }
      case "SET_ACTIVE_UNIT":
        return { ...state, unitSelection: setActiveUnit(state.unitSelection, action.unitId) }
      case "AI_SELECT_UNITS": {
        const byId = inventoryById(state.unitInventory)
        const caps = capacitiesOf(state.currentRoomPlan)
        let sel = state.unitSelection
        for (const id of action.unitIds) {
          const u = byId.get(id); if (!u || !u.available) continue   // skip unknown/unavailable
          // Only select units whose room TYPE is already in the plan — Ava adds
          // new types via propose_room_plan, never by side-effect of select_units.
          if (!caps[u.roomTypeId]) continue
          sel = tapUnit(sel, u.id, u.roomTypeId, caps[u.roomTypeId])
        }
        const planWithTotals =
          state.currentRoomPlan && state.unitInventory.length
            ? { ...state.currentRoomPlan, ...computeSelectionTotals(state.currentRoomPlan.rooms, sel, byId) }
            : state.currentRoomPlan
        return { ...state, currentRoomPlan: planWithTotals, unitSelection: sel }
      }
    }
  }

  // Unknown action — no-op (the journey machine was removed in D.3).
  return state
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type OmnamDispatch = (action: OmnamStoreAction) => void

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
    // Compute the next state synchronously against the mirror so synchronous
    // consumers observe the write before React's next render, then schedule
    // the React re-render (the reducer is pure, so React converges on the same
    // nextState).
    const nextState = omnamRootReducer(stateRef.current, action)
    stateRef.current = nextState
    reactDispatch(action)
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
