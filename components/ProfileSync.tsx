"use client"

import { useEffect, useRef } from "react"
import { useUserProfile } from "@/lib/liveavatar"
import { useUserProfileContext, type UserProfile } from "@/lib/context"

export function ProfileSync() {
  const { profile, isExtractionPending } = useUserProfile()
  const { profile: storedProfile, updateProfile } = useUserProfileContext()
  const lastSyncRef = useRef<string>("")

  useEffect(() => {
    const hasData =
      profile.name ||
      profile.destination ||
      profile.partySize ||
      profile.startDate ||
      profile.endDate ||
      profile.interests.length > 0 ||
      profile.travelPurpose ||
      profile.budgetRange ||
      profile.guestComposition ||
      profile.distributionPreference ||
      profile.roomTypePreference ||
      profile.dietaryRestrictions?.length ||
      profile.accessibilityNeeds?.length ||
      profile.amenityPriorities?.length ||
      profile.nationality ||
      profile.arrivalTime

    if (!hasData) return

    const syncKey = JSON.stringify({
      name: profile.name,
      destination: profile.destination,
      partySize: profile.partySize,
      startDate: profile.startDate?.toISOString(),
      endDate: profile.endDate?.toISOString(),
      interests: profile.interests,
      travelPurpose: profile.travelPurpose,
      budgetRange: profile.budgetRange,
      roomAllocation: profile.roomAllocation,
      guestComposition: profile.guestComposition,
      distributionPreference: profile.distributionPreference,
      roomTypePreference: profile.roomTypePreference,
      dietaryRestrictions: profile.dietaryRestrictions,
      accessibilityNeeds: profile.accessibilityNeeds,
      amenityPriorities: profile.amenityPriorities,
      nationality: profile.nationality,
      arrivalTime: profile.arrivalTime,
    })

    if (syncKey === lastSyncRef.current) return
    lastSyncRef.current = syncKey

    const [firstName, ...lastNameParts] = (profile.name ?? "").split(" ").filter(Boolean)
    const inferredLastName = lastNameParts.join(" ")

    const updates: Partial<UserProfile> = {}

    if (!storedProfile.firstName && firstName) {
      updates.firstName = firstName
    }
    if (!storedProfile.lastName && inferredLastName) {
      updates.lastName = inferredLastName
    }
    if (profile.partySize != null) {
      updates.familySize = profile.partySize
    }
    if (profile.destination) {
      updates.destination = profile.destination
    }
    if (profile.startDate) {
      updates.startDate = profile.startDate
    }
    if (profile.endDate) {
      updates.endDate = profile.endDate
    }
    if (profile.interests.length > 0) {
      updates.interests = profile.interests
    }
    if (profile.travelPurpose) {
      updates.travelPurpose = profile.travelPurpose
    }
    if (profile.budgetRange) {
      updates.budgetRange = profile.budgetRange
    }
    if (profile.roomTypePreference) {
      updates.roomTypePreference = profile.roomTypePreference
    }
    if (profile.dietaryRestrictions?.length) {
      updates.dietaryRestrictions = profile.dietaryRestrictions
    }
    if (profile.accessibilityNeeds?.length) {
      updates.accessibilityNeeds = profile.accessibilityNeeds
    }
    if (profile.amenityPriorities?.length) {
      updates.amenityPriorities = profile.amenityPriorities
    }
    if (profile.nationality) {
      updates.nationality = profile.nationality
    }
    if (profile.arrivalTime) {
      updates.arrivalTime = profile.arrivalTime
    }
    if (profile.guestComposition) {
      updates.guestComposition = profile.guestComposition
      updates.familySize = profile.guestComposition.adults + profile.guestComposition.children
    }
    if (profile.roomAllocation) {
      updates.roomAllocation = profile.roomAllocation
    }
    if (profile.distributionPreference) {
      updates.distributionPreference = profile.distributionPreference
    }

    if (Object.keys(updates).length > 0) {
      updateProfile(updates)
    }
  }, [
    profile.name,
    profile.destination,
    profile.partySize,
    profile.startDate,
    profile.endDate,
    profile.interests,
    profile.travelPurpose,
    profile.budgetRange,
    profile.roomTypePreference,
    profile.dietaryRestrictions,
    profile.accessibilityNeeds,
    profile.amenityPriorities,
    profile.nationality,
    profile.arrivalTime,
    profile.guestComposition,
    profile.roomAllocation,
    profile.distributionPreference,
    storedProfile.firstName,
    storedProfile.lastName,
    updateProfile,
  ])

  if (isExtractionPending) {
    return (
      <div className="fixed bottom-4 left-4 z-30 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 backdrop-blur">
        Analyzing...
      </div>
    )
  }

  return null
}
