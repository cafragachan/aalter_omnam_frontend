import { ref, get } from "firebase/database"
import { ref as storageRef, getDownloadURL } from "firebase/storage"
import { database, storage } from "@/lib/firebase"
import type { UserDBProfile } from "@/lib/auth-context"
import type {
  PersistedPersonality,
  PersistedPreferences,
  PersistedConsent,
  PersistedLoyalty,
  SessionPointer,
  SessionSnapshot,
} from "./types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuestRecord {
  uid: string
  identity: UserDBProfile
  personality: PersistedPersonality | null
  preferences: PersistedPreferences | null
  consent: PersistedConsent | null
  loyalty: PersistedLoyalty | null
  sessions: Record<string, SessionPointer> | null
}

export interface GuestSearchResult {
  uid: string
  identity: UserDBProfile
  loyalty: PersistedLoyalty | null
}

// ---------------------------------------------------------------------------
// Search — client-side filter over all users (works for small datasets)
// ---------------------------------------------------------------------------

export async function searchGuests(queryStr: string): Promise<GuestSearchResult[]> {
  if (!database) throw new Error("Firebase database not configured")

  const q = queryStr.toLowerCase().trim()
  if (!q) return []

  const snapshot = await get(ref(database, "omnam/users"))
  if (!snapshot.exists()) return []

  const allUsers = snapshot.val() as Record<string, Record<string, unknown>>
  const results: GuestSearchResult[] = []

  for (const [uid, userData] of Object.entries(allUsers)) {
    const identity = userData.identity as UserDBProfile | undefined
    if (!identity) continue

    const fullName = `${identity.firstName} ${identity.lastName}`.toLowerCase()
    const firstName = identity.firstName?.toLowerCase() ?? ""
    const lastName = identity.lastName?.toLowerCase() ?? ""
    const email = identity.email?.toLowerCase() ?? ""

    if (fullName.includes(q) || firstName.includes(q) || lastName.includes(q) || email.includes(q)) {
      results.push({
        uid,
        identity,
        loyalty: (userData.loyalty as PersistedLoyalty) ?? null,
      })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Fetch full guest record (all RTDB nodes)
// ---------------------------------------------------------------------------

export async function getGuestRecord(uid: string): Promise<GuestRecord | null> {
  if (!database) throw new Error("Firebase database not configured")

  const snapshot = await get(ref(database, `omnam/users/${uid}`))
  if (!snapshot.exists()) return null

  const data = snapshot.val()
  return {
    uid,
    identity: data.identity ?? null,
    personality: data.personality ?? null,
    preferences: data.preferences ?? null,
    consent: data.consent ?? null,
    loyalty: data.loyalty ?? null,
    sessions: data.sessions ?? null,
  }
}

// ---------------------------------------------------------------------------
// Download full session snapshot from Firebase Storage
// ---------------------------------------------------------------------------

export async function downloadSessionSnapshot(
  storagePath: string,
): Promise<SessionSnapshot | null> {
  if (!storage) throw new Error("Firebase storage not configured")

  try {
    const fileRef = storageRef(storage, storagePath)
    const url = await getDownloadURL(fileRef)
    const response = await fetch(url)
    if (!response.ok) return null
    return (await response.json()) as SessionSnapshot
  } catch (error) {
    console.error("[admin-service] Failed to download session snapshot:", error)
    return null
  }
}
