import { ref, get, set, update } from "firebase/database"
import { database } from "@/lib/firebase"
import type { UserProfile } from "@/lib/context"
import type { GuestIntelligence } from "@/lib/guest-intelligence"
import type {
  SessionSnapshot,
  PersistedPersonality,
  PersistedPreferences,
  PersistedConsent,
  PersistedLoyalty,
  ReturningUserData,
} from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unionSet(...arrays: (string[] | undefined)[]): string[] {
  const s = new Set<string>()
  for (const arr of arrays) {
    if (arr) for (const v of arr) if (v) s.add(v)
  }
  return Array.from(s)
}

function dbPath(userId: string, node: string) {
  return `omnam/users/${userId}/${node}`
}

async function readNode<T>(userId: string, node: string): Promise<T | null> {
  if (!database) return null
  const snapshot = await get(ref(database, dbPath(userId, node)))
  return snapshot.exists() ? (snapshot.val() as T) : null
}

async function writeNode<T>(userId: string, node: string, data: T): Promise<void> {
  if (!database) return
  await set(ref(database, dbPath(userId, node)), data)
}

// ---------------------------------------------------------------------------
// Merge personality (union traits + interests, last-write-wins for scalars)
// ---------------------------------------------------------------------------

export async function mergePersonality(
  userId: string,
  snapshot: SessionSnapshot,
): Promise<void> {
  const existing = await readNode<PersistedPersonality>(userId, "personality")
  const gi = snapshot.guestIntelligence

  const merged: PersistedPersonality = {
    traits: unionSet(existing?.traits, gi.personalityTraits),
    travelDrivers: unionSet(existing?.travelDrivers, gi.travelDriver ? [gi.travelDriver] : []),
    travelPurposes: snapshot.profile.travelPurpose ? [snapshot.profile.travelPurpose] : existing?.travelPurposes ?? [],
    budgetTendency: snapshot.profile.budgetRange ?? existing?.budgetTendency ?? null,
    upsellReceptivity: gi.upsellReceptivity ?? existing?.upsellReceptivity ?? null,
    interests: unionSet(existing?.interests, snapshot.profile.interests),
    dietaryRestrictions: unionSet(existing?.dietaryRestrictions, snapshot.profile.dietaryRestrictions),
    accessibilityNeeds: unionSet(existing?.accessibilityNeeds, snapshot.profile.accessibilityNeeds),
    amenityPriorities: unionSet(
      existing?.amenityPriorities,
      gi.amenitiesExplored.sort((a, b) => b.timeSpentMs - a.timeSpentMs).map((a) => a.name),
    ),
    topObjectionTopics: unionSet(existing?.topObjectionTopics, gi.objections.map((o) => o.topic)),
    updatedAt: new Date().toISOString(),
  }

  await writeNode(userId, "personality", merged)
}

// ---------------------------------------------------------------------------
// Merge preferences (union sets, last-write-wins for scalars)
// ---------------------------------------------------------------------------

export async function mergePreferences(
  userId: string,
  snapshot: SessionSnapshot,
): Promise<void> {
  const existing = await readNode<PersistedPreferences>(userId, "preferences")
  const gi = snapshot.guestIntelligence
  const profile = snapshot.profile

  // Sort explored items by time spent (descending) for priority ordering
  const roomNames = gi.roomsExplored
    .sort((a, b) => b.timeSpentMs - a.timeSpentMs)
    .map((r) => r.roomId)
  const amenityNames = gi.amenitiesExplored
    .sort((a, b) => b.timeSpentMs - a.timeSpentMs)
    .map((a) => a.name)

  const guestComp = profile.guestComposition
    ? { adults: profile.guestComposition.adults ?? 1, children: profile.guestComposition.children ?? 0 }
    : existing?.typicalGuestComposition ?? null

  const merged: PersistedPreferences = {
    preferredRoomTypes: unionSet(roomNames, existing?.preferredRoomTypes),
    preferredDestinations: unionSet(
      profile.destination ? [profile.destination] : [],
      existing?.preferredDestinations,
    ),
    preferredAmenities: unionSet(amenityNames, existing?.preferredAmenities),
    typicalGuestComposition: guestComp,
    typicalStayLength: existing?.typicalStayLength ?? null,
    updatedAt: new Date().toISOString(),
  }

  await writeNode(userId, "preferences", merged)
}

// ---------------------------------------------------------------------------
// Update loyalty counters
// ---------------------------------------------------------------------------

export async function updateLoyalty(
  userId: string,
  bookingOutcome: string,
): Promise<void> {
  const existing = await readNode<PersistedLoyalty>(userId, "loyalty")
  const now = new Date().toISOString()

  const merged: PersistedLoyalty = {
    tier: existing?.tier ?? null,
    totalSessions: (existing?.totalSessions ?? 0) + 1,
    totalBookings:
      (existing?.totalBookings ?? 0) + (bookingOutcome === "booked" ? 1 : 0),
    lifetimeValue: existing?.lifetimeValue ?? 0,
    firstSessionAt: existing?.firstSessionAt ?? now,
    lastSessionAt: now,
  }

  await writeNode(userId, "loyalty", merged)
}

// ---------------------------------------------------------------------------
// Update consent flags
// ---------------------------------------------------------------------------

export async function updateConsent(
  userId: string,
  flags: { marketing: boolean; dataSharing: boolean; analytics: boolean; thirdParty: boolean },
): Promise<void> {
  const consent: PersistedConsent = {
    ...flags,
    updatedAt: new Date().toISOString(),
  }
  await writeNode(userId, "consent", consent)
}

// ---------------------------------------------------------------------------
// Load returning user data (called on login)
// ---------------------------------------------------------------------------

export async function loadReturningUser(userId: string): Promise<ReturningUserData> {
  const [personality, preferences, loyalty] = await Promise.all([
    readNode<PersistedPersonality>(userId, "personality"),
    readNode<PersistedPreferences>(userId, "preferences"),
    readNode<PersistedLoyalty>(userId, "loyalty"),
  ])
  return { personality, preferences, loyalty }
}

// ---------------------------------------------------------------------------
// Orchestrator — persist all session data in parallel (end-of-session)
// ---------------------------------------------------------------------------

export async function persistSessionData(
  userId: string,
  snapshot: SessionSnapshot,
): Promise<void> {
  const bookingOutcome = snapshot.guestIntelligence.bookingOutcome

  const results = await Promise.allSettled([
    mergePersonality(userId, snapshot),
    mergePreferences(userId, snapshot),
    updateLoyalty(userId, bookingOutcome),
    updateConsent(userId, snapshot.guestIntelligence.consentFlags),
  ])

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[user-profile-service] Partial failure:", result.reason)
    }
  }
}

// ===========================================================================
// INCREMENTAL PERSISTENCE — called throughout the session
// ===========================================================================

// ---------------------------------------------------------------------------
// Merge personality from live profile + GI data (no full snapshot needed)
// ---------------------------------------------------------------------------

export async function mergePersonalityIncremental(
  userId: string,
  profile: UserProfile,
  gi: GuestIntelligence,
): Promise<void> {
  const existing = await readNode<PersistedPersonality>(userId, "personality")

  const merged: PersistedPersonality = {
    traits: unionSet(existing?.traits, gi.personalityTraits),
    travelDrivers: unionSet(existing?.travelDrivers, gi.travelDriver ? [gi.travelDriver] : []),
    travelPurposes: unionSet(existing?.travelPurposes, profile.travelPurpose ? [profile.travelPurpose] : []),
    budgetTendency: profile.budgetRange ?? existing?.budgetTendency ?? null,
    upsellReceptivity: gi.upsellReceptivity ?? existing?.upsellReceptivity ?? null,
    interests: unionSet(existing?.interests, profile.interests),
    dietaryRestrictions: unionSet(existing?.dietaryRestrictions, profile.dietaryRestrictions),
    accessibilityNeeds: unionSet(existing?.accessibilityNeeds, profile.accessibilityNeeds),
    amenityPriorities: unionSet(
      existing?.amenityPriorities,
      [...gi.amenitiesExplored].sort((a, b) => b.timeSpentMs - a.timeSpentMs).map((a) => a.name),
    ),
    topObjectionTopics: unionSet(existing?.topObjectionTopics, gi.objections.map((o) => o.topic)),
    updatedAt: new Date().toISOString(),
  }

  await writeNode(userId, "personality", merged)
}

// ---------------------------------------------------------------------------
// Merge preferences from live profile + GI data (no full snapshot needed)
// ---------------------------------------------------------------------------

export async function mergePreferencesIncremental(
  userId: string,
  profile: UserProfile,
  gi: GuestIntelligence,
): Promise<void> {
  const existing = await readNode<PersistedPreferences>(userId, "preferences")

  const roomNames = [...gi.roomsExplored]
    .sort((a, b) => b.timeSpentMs - a.timeSpentMs)
    .map((r) => r.roomId)
  const amenityNames = [...gi.amenitiesExplored]
    .sort((a, b) => b.timeSpentMs - a.timeSpentMs)
    .map((a) => a.name)

  const guestComp = profile.guestComposition
    ? { adults: profile.guestComposition.adults ?? 1, children: profile.guestComposition.children ?? 0 }
    : existing?.typicalGuestComposition ?? null

  const merged: PersistedPreferences = {
    preferredRoomTypes: unionSet(roomNames, existing?.preferredRoomTypes),
    preferredDestinations: unionSet(
      profile.destination ? [profile.destination] : [],
      existing?.preferredDestinations,
    ),
    preferredAmenities: unionSet(amenityNames, existing?.preferredAmenities),
    typicalGuestComposition: guestComp,
    typicalStayLength: existing?.typicalStayLength ?? null,
    updatedAt: new Date().toISOString(),
  }

  await writeNode(userId, "preferences", merged)
}

// ---------------------------------------------------------------------------
// Increment totalSessions atomically (called once at session start)
// ---------------------------------------------------------------------------

export async function incrementTotalSessions(userId: string): Promise<void> {
  if (!database) return
  const existing = await readNode<PersistedLoyalty>(userId, "loyalty")
  const now = new Date().toISOString()

  const updates: Record<string, unknown> = {
    totalSessions: (existing?.totalSessions ?? 0) + 1,
    lastSessionAt: now,
  }
  if (!existing?.firstSessionAt) {
    updates.firstSessionAt = now
  }
  // Initialize fields that might not exist yet
  if (existing?.tier === undefined) updates.tier = null
  if (existing?.totalBookings === undefined) updates.totalBookings = 0
  if (existing?.lifetimeValue === undefined) updates.lifetimeValue = 0

  await update(ref(database, dbPath(userId, "loyalty")), updates)
}

// ---------------------------------------------------------------------------
// Increment totalBookings (called when bookingOutcome becomes "booked")
// ---------------------------------------------------------------------------

export async function incrementTotalBookings(userId: string): Promise<void> {
  if (!database) return
  const existing = await readNode<PersistedLoyalty>(userId, "loyalty")
  await update(ref(database, dbPath(userId, "loyalty")), {
    totalBookings: (existing?.totalBookings ?? 0) + 1,
  })
}
