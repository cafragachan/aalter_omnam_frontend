"use client"

import { useEffect, useState } from "react"
import { initVagonMachine } from "@/lib/vagon-client"

export interface VagonSession {
  /** URL to set as iframe src */
  connectionLink: string | null
  /** Machine is assigned and streaming */
  isReady: boolean
  /** Session is initializing (loading state) */
  isLoading: boolean
  /** Error message if lifecycle failed */
  error: string | null
}

/**
 * Manages the Vagon machine lifecycle for Availability Optimized streams:
 * getStreams → startMachine → assignMachine. Teardown is handled by
 * Vagon's platform-side idle reaper so the cache-snapshot step can run.
 *
 * Only active when `enabled` is true (i.e. streamMode === "vagon").
 */
export function useVagonSession(enabled: boolean): VagonSession {
  const [connectionLink, setConnectionLink] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return

    setIsLoading(true)
    setError(null)

    let cancelled = false

    const init = async () => {
      try {
        const { connectionLink: link } = await initVagonMachine()
        if (cancelled) return

        setConnectionLink(link)
        setIsReady(true)
        setIsLoading(false)
      } catch (err) {
        if (!cancelled) {
          console.error("[useVagonSession] init failed:", err)
          setError((err as Error).message)
          setIsLoading(false)
        }
      }
    }

    init()

    return () => {
      cancelled = true
    }
  }, [enabled])

  return { connectionLink, isReady, isLoading, error }
}
