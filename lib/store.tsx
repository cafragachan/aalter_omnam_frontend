"use client"

// ---------------------------------------------------------------------------
// AppContext — Phase 6 compat shim.
//
// The actual state lives in `lib/omnam-store.tsx`. This file keeps the
// pre-Phase-6 import surface alive so every existing consumer
// (`useApp`, `AppProvider`) continues to work without changes. Both the
// /home path and the /home-v2 path read through this shim; flipping them to
// import from `@/lib/omnam-store` directly can happen gradually later.
//
// See `lib/omnam-store.tsx` for the real reducer + provider.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, type ReactNode } from "react"
import {
  useOmnamStore,
  type AppBooking,
  type AppSearchCriteria,
} from "@/lib/omnam-store"

interface AppContextType {
  searchCriteria: AppSearchCriteria
  selectedHotel: string | null
  bookings: AppBooking[]
  isLoading: boolean
  updateSearchCriteria: (criteria: Partial<AppSearchCriteria>) => void
  selectHotel: (slug: string) => void
  addBooking: (booking: Omit<AppBooking, "id" | "createdAt">) => void
  setLoading: (loading: boolean) => void
}

/**
 * No-op wrapper kept for backwards compatibility with `/home-v2` imports.
 * The real store is mounted at `OmnamStoreProvider` in `app/layout.tsx`, so
 * rendering this provider simply passes children through — stacking both
 * providers is a safe no-op.
 */
export function AppProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function useApp(): AppContextType {
  const { state, dispatch } = useOmnamStore()

  const updateSearchCriteria = useCallback(
    (criteria: Partial<AppSearchCriteria>) => {
      dispatch({ type: "UPDATE_SEARCH_CRITERIA", criteria })
    },
    [dispatch],
  )

  const selectHotel = useCallback(
    (slug: string) => {
      dispatch({ type: "SELECT_HOTEL", slug })
    },
    [dispatch],
  )

  const addBooking = useCallback(
    (booking: Omit<AppBooking, "id" | "createdAt">) => {
      dispatch({ type: "ADD_BOOKING", booking })
    },
    [dispatch],
  )

  const setLoading = useCallback(
    (loading: boolean) => {
      dispatch({ type: "SET_LOADING", loading })
    },
    [dispatch],
  )

  return useMemo<AppContextType>(
    () => ({
      searchCriteria: state.app.searchCriteria,
      selectedHotel: state.app.selectedHotel,
      bookings: state.app.bookings,
      isLoading: state.app.isLoading,
      updateSearchCriteria,
      selectHotel,
      addBooking,
      setLoading,
    }),
    [state.app, updateSearchCriteria, selectHotel, addBooking, setLoading],
  )
}
