"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

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

const createEmptyProfile = (): UserProfile => ({
  interests: [],
  startDate: null,
  endDate: null,
})

const UserProfileContext = createContext<UserProfileContextValue | null>(null)

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile>(createEmptyProfile())
  const [journeyStage, setJourneyStage] = useState<JourneyStage>("PROFILE_COLLECTION")

  const updateProfile = useCallback((updates: Partial<UserProfile>) => {
    setProfile((prev) => {
      // guestComposition must deep-merge — a partial update like
      // { childrenAges: [10, 15] } otherwise wipes adults/children from prior
      // turns. Same applies if a future turn sends just { adults: 3 }.
      const mergedGuestComposition = updates.guestComposition
        ? { ...(prev.guestComposition ?? {}), ...updates.guestComposition }
        : prev.guestComposition
      // Drop familySize from incoming updates if it's NaN (caller computed it
      // from an incomplete guestComposition). We'll recompute below when we
      // have the full merged composition.
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
    })
  }, [])

  const resetProfile = useCallback(() => setProfile(createEmptyProfile()), [])

  const value = useMemo(
    () => ({
      profile,
      journeyStage,
      setJourneyStage,
      updateProfile,
      resetProfile,
    }),
    [journeyStage, profile, resetProfile, setJourneyStage, updateProfile],
  )

  return <UserProfileContext.Provider value={value}>{children}</UserProfileContext.Provider>
}

export function useUserProfileContext() {
  const context = useContext(UserProfileContext)
  if (!context) {
    throw new Error("useUserProfileContext must be used within a UserProfileProvider")
  }
  return context
}

const mergeUnique = (current: string[], incoming?: string[]) => {
  if (!incoming) return current
  const unique = new Set([...current, ...incoming.filter(Boolean)])
  return Array.from(unique)
}

