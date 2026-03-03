import type { UserProfile, JourneyStage } from "@/lib/context"
import type { Hotel } from "@/lib/hotel-data"

// ---------------------------------------------------------------------------
// Dynamic HeyGen Context Builder
// ---------------------------------------------------------------------------
// Builds context strings that can be injected into the HeyGen avatar's
// knowledge base dynamically as the conversation progresses.
// ---------------------------------------------------------------------------

/** Fields we want to collect, in priority order */
const COLLECTION_PRIORITIES: (keyof UserProfile)[] = [
  "startDate",
  "endDate",
  "familySize",
  "guestComposition",
  "travelPurpose",
  "destination",
  "roomTypePreference",
  "interests",
  "dietaryRestrictions",
  "accessibilityNeeds",
  "amenityPriorities",
  "nationality",
  "arrivalTime",
  "budgetRange",
]

function formatProfileValue(key: string, value: unknown): string {
  if (value instanceof Date) return value.toLocaleDateString()
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : ""
  if (typeof value === "object" && value !== null) return JSON.stringify(value)
  return String(value)
}

/**
 * Build a context summary of what we know about the guest.
 */
export function buildKnownProfileSummary(profile: UserProfile): string {
  const known: string[] = []

  if (profile.firstName) known.push(`Name: ${profile.firstName} ${profile.lastName ?? ""}`.trim())
  if (profile.startDate && profile.endDate) {
    known.push(`Dates: ${profile.startDate.toLocaleDateString()} - ${profile.endDate.toLocaleDateString()}`)
  }
  if (profile.guestComposition) {
    const { adults, children, childrenAges } = profile.guestComposition
    let comp = `${adults} adult${adults !== 1 ? "s" : ""}`
    if (children > 0) {
      comp += `, ${children} child${children !== 1 ? "ren" : ""}`
      if (childrenAges?.length) comp += ` (ages ${childrenAges.join(", ")})`
    }
    known.push(`Guests: ${comp}`)
  } else if (profile.familySize) {
    known.push(`Guests: ${profile.familySize}`)
  }
  if (profile.travelPurpose) known.push(`Purpose: ${profile.travelPurpose}`)
  if (profile.destination) known.push(`Destination: ${profile.destination}`)
  if (profile.interests.length > 0) known.push(`Interests: ${profile.interests.join(", ")}`)
  if (profile.roomTypePreference) known.push(`Room preference: ${profile.roomTypePreference}`)
  if (profile.dietaryRestrictions?.length) known.push(`Dietary: ${profile.dietaryRestrictions.join(", ")}`)
  if (profile.accessibilityNeeds?.length) known.push(`Accessibility: ${profile.accessibilityNeeds.join(", ")}`)
  if (profile.nationality) known.push(`From: ${profile.nationality}`)
  if (profile.arrivalTime) known.push(`Arrival: ${profile.arrivalTime}`)
  if (profile.budgetRange) known.push(`Budget: ${profile.budgetRange}`)

  return known.join("\n")
}

/**
 * Get the next 2-3 data points we should try to collect naturally.
 */
export function getMissingPriorityFields(profile: UserProfile): string[] {
  const missing: string[] = []

  for (const key of COLLECTION_PRIORITIES) {
    const value = profile[key]
    const isEmpty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)

    if (isEmpty) {
      missing.push(key)
    }
    if (missing.length >= 3) break
  }

  return missing
}

/**
 * Build the full avatar context string for the current state.
 */
export function buildAvatarContext(
  profile: UserProfile,
  stage: JourneyStage,
  hotel?: Hotel,
): string {
  const knownSummary = buildKnownProfileSummary(profile)
  const missing = getMissingPriorityFields(profile)

  const lines: string[] = [
    `Current guest: ${profile.firstName ?? "Guest"} ${profile.lastName ?? ""}`.trim(),
    `Journey stage: ${stage}`,
    "",
    "Already collected:",
    knownSummary || "(nothing yet)",
    "",
    `Data to collect naturally during conversation: ${missing.join(", ") || "(all key data collected)"}`,
  ]

  if (hotel) {
    lines.push(
      "",
      "Hotel context:",
      `- Property: ${hotel.name} in ${hotel.location}`,
      `- ${hotel.description}`,
    )
  }

  return lines.join("\n")
}
