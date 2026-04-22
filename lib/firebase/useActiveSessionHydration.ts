"use client"

import { useEffect, useState } from "react"
import { ref as dbRef, get, remove } from "firebase/database"
import { auth, database } from "@/lib/firebase"
import type { LiveAvatarSessionMessage } from "@/lib/liveavatar/types"
import { MessageSender } from "@/lib/liveavatar/types"

// ---------------------------------------------------------------------------
// Phase 5 — Conversation persistence hydration.
//
// On mount, if the authenticated user has an entry at
// `omnam/users/{uid}/activeSession` that is fresh (< MAX_AGE_MS) and NOT at
// a terminal stage, return its messages so `LiveAvatarContextProvider` can
// seed them before HeyGen starts streaming.
//
// If the entry is stale or terminal, delete it so the `activeSession` node
// holds at most one meaningful record per user.
// ---------------------------------------------------------------------------

const MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes

// Terminal stages that should NOT be resumed.
const TERMINAL_STAGES = new Set(["END_EXPERIENCE"])

type ActiveSessionRecord = {
  sessionId?: string
  stage?: string
  updatedAt?: string
  startedAt?: string
  messages?: Array<{ sender: string; message: string; timestamp: number }>
}

export type ActiveSessionHydrationResult = {
  /** True once the hydration attempt has finished (ok, missing, or failed). */
  isHydrationReady: boolean
  /**
   * Messages seeded from a resumable session. Always an array; empty when no
   * hydration happened. Consumers should treat this as an initial value — it
   * is set once and never mutated afterwards.
   */
  initialMessages: LiveAvatarSessionMessage[]
}

function parseSender(value: string): MessageSender {
  return value === MessageSender.AVATAR ? MessageSender.AVATAR : MessageSender.USER
}

function normalizeMessages(raw: ActiveSessionRecord["messages"]): LiveAvatarSessionMessage[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m) => m && typeof m.message === "string")
    .map((m) => ({
      sender: parseSender(m.sender),
      message: m.message,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
    }))
}

/**
 * Fetches the authenticated user's `activeSession` record once on mount.
 *
 * - Disabled when Firebase is not configured or the user is anonymous —
 *   returns `{ isHydrationReady: true, initialMessages: [] }` immediately.
 * - Logs `[HYDRATE]` on a successful resume, `[HYDRATE-SKIP]` otherwise.
 */
export function useActiveSessionHydration(enabled: boolean): ActiveSessionHydrationResult {
  const [state, setState] = useState<ActiveSessionHydrationResult>({
    isHydrationReady: false,
    initialMessages: [],
  })

  useEffect(() => {
    if (!enabled) {
      setState({ isHydrationReady: true, initialMessages: [] })
      return
    }

    const uid = auth?.currentUser?.uid ?? null
    if (!database || !uid) {
      console.log("[HYDRATE-SKIP]", { reason: "no-session" })
      setState({ isHydrationReady: true, initialMessages: [] })
      return
    }

    let cancelled = false
    const pathRef = dbRef(database, `omnam/users/${uid}/activeSession`)

    get(pathRef)
      .then((snapshot) => {
        if (cancelled) return
        if (!snapshot.exists()) {
          console.log("[HYDRATE-SKIP]", { reason: "no-session" })
          setState({ isHydrationReady: true, initialMessages: [] })
          return
        }

        const data = snapshot.val() as ActiveSessionRecord | null
        if (!data) {
          console.log("[HYDRATE-SKIP]", { reason: "no-session" })
          setState({ isHydrationReady: true, initialMessages: [] })
          return
        }

        const updatedAtMs = data.updatedAt ? Date.parse(data.updatedAt) : NaN
        const ageMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Infinity
        const ageMinutes = Math.round(ageMs / 60000)
        const stage = data.stage ?? "UNKNOWN"

        if (TERMINAL_STAGES.has(stage)) {
          console.log("[HYDRATE-SKIP]", { reason: "terminal", stage, sessionId: data.sessionId })
          remove(pathRef).catch(() => {})
          setState({ isHydrationReady: true, initialMessages: [] })
          return
        }

        if (!Number.isFinite(updatedAtMs) || ageMs > MAX_AGE_MS) {
          console.log("[HYDRATE-SKIP]", { reason: "stale", ageMinutes, sessionId: data.sessionId })
          remove(pathRef).catch(() => {})
          setState({ isHydrationReady: true, initialMessages: [] })
          return
        }

        const messages = normalizeMessages(data.messages)
        if (messages.length === 0) {
          console.log("[HYDRATE-SKIP]", { reason: "no-session", note: "empty-messages" })
          setState({ isHydrationReady: true, initialMessages: [] })
          return
        }

        console.log("[HYDRATE]", {
          sessionId: data.sessionId,
          messageCount: messages.length,
          lastWriteAt: data.updatedAt,
          ageMinutes,
          stage,
        })
        setState({ isHydrationReady: true, initialMessages: messages })
      })
      .catch((err) => {
        console.error("[HYDRATE] Failed to read activeSession:", err)
        setState({ isHydrationReady: true, initialMessages: [] })
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}
