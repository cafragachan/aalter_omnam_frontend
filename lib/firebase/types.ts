import type { UserProfile, GuestComposition } from "@/lib/context"
import type { GuestIntelligence } from "@/lib/guest-intelligence"

// ---------------------------------------------------------------------------
// Serialized profile (Date objects → ISO strings for Firebase)
// ---------------------------------------------------------------------------

export type SerializedUserProfile = Omit<
  UserProfile,
  "startDate" | "endDate" | "dateOfBirth"
> & {
  startDate?: string | null
  endDate?: string | null
  dateOfBirth?: string | null
}

// ---------------------------------------------------------------------------
// Session Snapshot — full immutable record stored in Firebase Storage
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  sessionId: string
  userId: string
  startedAt: string
  endedAt: string
  profile: SerializedUserProfile
  guestIntelligence: GuestIntelligence
  journeyStage: string
  conversationMessages: { sender: string; message: string; timestamp: number }[]
  hotel: string | null
}

// ---------------------------------------------------------------------------
// Session Pointer — lightweight reference stored in RTDB
// ---------------------------------------------------------------------------

export interface SessionPointer {
  startedAt: string
  endedAt: string
  hotel: string | null
  journeyStage: string
  bookingOutcome: string
  storagePath: string
}

// ---------------------------------------------------------------------------
// Persisted user data nodes (RTDB)
// ---------------------------------------------------------------------------

export interface PersistedPersonality {
  traits: string[]
  travelDrivers: string[]
  travelPurposes: string[]
  budgetTendency: string | null
  upsellReceptivity: number | null
  interests: string[]
  dietaryRestrictions: string[]
  accessibilityNeeds: string[]
  amenityPriorities: string[]
  topObjectionTopics: string[]
  updatedAt: string
}

export interface PersistedPreferences {
  preferredRoomTypes: string[]
  preferredDestinations: string[]
  preferredAmenities: string[]
  typicalGuestComposition: { adults: number; children: number } | null
  typicalStayLength: number | null
  updatedAt: string
}

export interface PersistedConsent {
  marketing: boolean
  dataSharing: boolean
  analytics: boolean
  thirdParty: boolean
  updatedAt: string
}

export interface PersistedLoyalty {
  tier: string | null
  totalSessions: number
  totalBookings: number
  lifetimeValue: number
  firstSessionAt: string
  lastSessionAt: string
}

// ---------------------------------------------------------------------------
// Combined returning-user payload (read on login)
// ---------------------------------------------------------------------------

export interface ReturningUserData {
  personality: PersistedPersonality | null
  preferences: PersistedPreferences | null
  loyalty: PersistedLoyalty | null
}
