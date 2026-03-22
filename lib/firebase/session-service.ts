import { ref as storageRef, uploadString } from "firebase/storage"
import { ref as dbRef, set } from "firebase/database"
import { storage, database } from "@/lib/firebase"
import type { SessionSnapshot, SessionPointer } from "./types"

// ---------------------------------------------------------------------------
// Upload full session snapshot to Firebase Storage
// ---------------------------------------------------------------------------

export async function uploadSessionSnapshot(
  userId: string,
  sessionId: string,
  snapshot: SessionSnapshot,
): Promise<string> {
  const path = `sessions/${userId}/${sessionId}.json`
  if (!storage) {
    console.warn("[session-service] Firebase Storage not configured — skipping upload")
    return path
  }
  const fileRef = storageRef(storage, path)
  await uploadString(fileRef, JSON.stringify(snapshot, null, 2), "raw", {
    contentType: "application/json",
  })
  return path
}

// ---------------------------------------------------------------------------
// Write lightweight session pointer to Realtime Database
// ---------------------------------------------------------------------------

export async function writeSessionPointer(
  userId: string,
  sessionId: string,
  pointer: SessionPointer,
): Promise<void> {
  if (!database) {
    console.warn("[session-service] Firebase Database not configured — skipping pointer write")
    return
  }
  await set(dbRef(database, `omnam/users/${userId}/sessions/${sessionId}`), pointer)
}
