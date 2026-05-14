/**
 * Server-side proxy for Vagon machine initialization.
 *
 * Runs the lifecycle for Availability Optimized streams:
 *   getStreams → assignMachine.
 * Keeps HMAC secrets server-side — the client only gets the connection link.
 */

import { getStreams, assignMachine } from "@/lib/vagon-api"

export async function POST() {
  try {
    const streamId = await getStreams()
    const { connectionLink, machineId } = await assignMachine(streamId)

    return Response.json({ connectionLink, machineId })
  } catch (error) {
    console.error("[vagon-init] Error:", error)
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    )
  }
}
