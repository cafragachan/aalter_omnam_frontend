"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

export type UserProfile = {
  firstName?: string
  lastName?: string
  email?: string
  age?: number
  familySize?: number
  interests: string[]
  destinationPreferences: string[]
  travelPurpose?: string
  budgetRange?: string
  loyaltyTier?: string
  notes?: string
}

type UserProfileContextValue = {
  profile: UserProfile
  updateProfile: (updates: Partial<UserProfile>) => void
  resetProfile: () => void
}

const createEmptyProfile = (): UserProfile => ({
  interests: [],
  destinationPreferences: [],
})

const UserProfileContext = createContext<UserProfileContextValue | null>(null)

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile>(createEmptyProfile())

  const updateProfile = useCallback((updates: Partial<UserProfile>) => {
    setProfile((prev) => ({
      ...prev,
      ...updates,
      interests: mergeUnique(prev.interests, updates.interests),
      destinationPreferences: mergeUnique(prev.destinationPreferences, updates.destinationPreferences),
    }))
  }, [])

  const resetProfile = useCallback(() => setProfile(createEmptyProfile()), [])

  const value = useMemo(
    () => ({
      profile,
      updateProfile,
      resetProfile,
    }),
    [profile, resetProfile, updateProfile],
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

