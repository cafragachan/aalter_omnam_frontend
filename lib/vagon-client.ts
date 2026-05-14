/**
 * Client-side Vagon helpers — calls server-side API routes
 * so HMAC secrets stay on the server.
 */

export interface VagonInitResult {
  connectionLink: string
  machineId: string
}

/** Initialize a Vagon machine (getStreams -> start -> assign) via server route. */
export async function initVagonMachine(): Promise<VagonInitResult> {
  const res = await fetch("/api/vagon-init", { method: "POST" })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Vagon init failed: ${res.status}`)
  }
  return res.json()
}
