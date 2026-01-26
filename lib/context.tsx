"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

export type UserProfile = {
  firstName?: string
  lastName?: string
  email?: string
  startDate?: Date | null
  endDate?: Date | null
  age?: number
  familySize?: number
  interests: string[]
  destination?: string
  travelPurpose?: string
  budgetRange?: string
  loyaltyTier?: string
  notes?: string
}

export type JourneyStage =
  | "PROFILE_COLLECTION"
  | "DESTINATION_SELECT"
  | "HOTEL_EXPLORATION"
  | "ROOM_BOOKING"

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
    setProfile((prev) => ({
      ...prev,
      ...updates,
      interests: mergeUnique(prev.interests, updates.interests),
    }))
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

