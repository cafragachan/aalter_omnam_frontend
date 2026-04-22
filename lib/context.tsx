"use client"

// ---------------------------------------------------------------------------
// UserProfileContext — Phase 6 compat shim.
//
// The actual state lives in `lib/omnam-store.tsx`. This file keeps the
// pre-Phase-6 import surface alive so every existing consumer
// (`useUserProfileContext`, `UserProfileProvider`, the `UserProfile` and
// `JourneyStage` types, etc.) continues to work without changes. Flipping
// consumers to import from `@/lib/omnam-store` directly can happen gradually
// later.
//
// See `lib/omnam-store.tsx` for the real reducer + provider.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, type ReactNode } from "react"
import { useOmnamStore } from "@/lib/omnam-store"

export type GuestComposition = {
  adults: number
  children: number
  childrenAges?: number[]
}

export type DistributionPreference = "together" | "separate" | "auto"

export type UserProfile = {
  // --- From Login (P0) ---
  firstName?: string
  lastName?: string
  email?: string
  phoneNumber?: string
  dateOfBirth?: Date | null

  // --- From Conversation (P0) ---
  startDate?: Date | null
  endDate?: Date | null
  guestComposition?: GuestComposition
  familySize?: number             // backward compat, derived from guestComposition
  destination?: string
  roomTypePreference?: string
  accessibilityNeeds?: string[]
  distributionPreference?: DistributionPreference
  /** Room allocation: how many guests per room, e.g. [4, 2] = 2 rooms for 6 guests */
  roomAllocation?: number[]

  // --- From Conversation (P1) ---
  interests: string[]
  travelPurpose?: string
  budgetRange?: string
  dietaryRestrictions?: string[]
  amenityPriorities?: string[]
  arrivalTime?: string
  nationality?: string
  languagePreference?: string
  loyaltyTier?: string
  notes?: string
}

export type JourneyStage =
  | "PROFILE_COLLECTION"
  | "DESTINATION_SELECT"
  | "VIRTUAL_LOUNGE"
  | "HOTEL_EXPLORATION"
  | "END_EXPERIENCE"

type UserProfileContextValue = {
  profile: UserProfile
  journeyStage: JourneyStage
  setJourneyStage: (stage: JourneyStage) => void
  updateProfile: (updates: Partial<UserProfile>) => void
  resetProfile: () => void
}

/**
 * No-op wrapper kept for backwards compatibility with legacy imports.
 * The real store is mounted at `OmnamStoreProvider` in `app/layout.tsx`, so
 * rendering this provider simply passes children through — stacking both
 * providers is a safe no-op.
 */
export function UserProfileProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function useUserProfileContext(): UserProfileContextValue {
  const { state, dispatch } = useOmnamStore()

  const setJourneyStage = useCallback(
    (stage: JourneyStage) => {
      dispatch({ type: "SET_JOURNEY_STAGE", stage })
    },
    [dispatch],
  )

  const updateProfile = useCallback(
    (updates: Partial<UserProfile>) => {
      dispatch({ type: "UPDATE_PROFILE", updates })
    },
    [dispatch],
  )

  const resetProfile = useCallback(() => {
    dispatch({ type: "RESET_PROFILE" })
  }, [dispatch])

  // Memoize the returned object against the slices this hook actually reads,
  // so consumers' dependency arrays stay stable when unrelated slices change.
  return useMemo<UserProfileContextValue>(
    () => ({
      profile: state.profile,
      journeyStage: state.journeyStage,
      setJourneyStage,
      updateProfile,
      resetProfile,
    }),
    [state.profile, state.journeyStage, setJourneyStage, updateProfile, resetProfile],
  )
}
