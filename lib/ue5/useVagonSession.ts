"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { getStreams, startMachine, assignMachine, stopMachine } from "@/lib/vagon-api"

const STORAGE_KEY = "vagon_machine_id"

export interface VagonSession {
  /** URL to set as iframe src */
  connectionLink: string | null
  /** Machine is assigned and streaming */
  isReady: boolean
  /** Session is initializing (loading state) */
  isLoading: boolean
  /** Error message if lifecycle failed */
  error: string | null
  /** Imperatively stop the machine */
  stop: () => Promise<void>
  /** The machine ID (needed for beacon cleanup) */
  machineId: string | null
}

function saveMachineId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* SSR or storage unavailable */ }
}

function loadAndClearMachineId(): string | null {
  try {
    const id = sessionStorage.getItem(STORAGE_KEY)
    if (id) sessionStorage.removeItem(STORAGE_KEY)
    return id
  } catch {
    return null
  }
}

/**
 * Manages the Vagon machine lifecycle for Availability Optimized streams:
 *   1. Stop any stale machine from a previous page load (handles refresh)
 *   2. getStreams → assignMachine → ready (machine ID + connection link)
 *
 * Only active when `enabled` is true (i.e. streamMode === "vagon").
 */
export function useVagonSession(enabled: boolean): VagonSession {
  const [connectionLink, setConnectionLink] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const machineIdRef = useRef<string | null>(null)
  const stoppedRef = useRef(false)

  const stop = useCallback(async () => {
    stoppedRef.current = true
    if (machineIdRef.current) {
      try {
        await stopMachine(machineIdRef.current)
      } catch (err) {
        console.error("[useVagonSession] stop failed:", err)
      }
    }
    saveMachineId(null)
    machineIdRef.current = null
    setIsReady(false)
    setConnectionLink(null)
  }, [])

  useEffect(() => {
    if (!enabled) return

    stoppedRef.current = false
    setIsLoading(true)
    setError(null)

    let cancelled = false

    const init = async () => {
      try {
        // Stop any leftover machine from a previous page load (refresh)
        const staleId = loadAndClearMachineId()
        if (staleId) {
          console.log("[useVagonSession] Stopping stale machine:", staleId)
          await stopMachine(staleId).catch(() => {})
        }
        if (cancelled || stoppedRef.current) return

        // 1. Get stream
        const streamId = await getStreams()
        if (cancelled || stoppedRef.current) return

        // 2. Start machine
        await startMachine(streamId)
        if (cancelled || stoppedRef.current) return

        // 3. Assign machine → connection link + machine ID
        const { connectionLink: link, machineId } = await assignMachine(streamId)
        if (cancelled || stoppedRef.current) return

        machineIdRef.current = machineId
        saveMachineId(machineId)
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

  return {
    connectionLink,
    isReady,
    isLoading,
    error,
    stop,
    machineId: machineIdRef.current,
  }
}
