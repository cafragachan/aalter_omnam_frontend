/**
 * Server-side proxy for Vagon machine initialization.
 *
 * Runs the full lifecycle: getStreams -> startMachine -> assignMachine.
 * Keeps HMAC secrets server-side — the client only gets the connection link.
 */

import { getStreams, startMachine, assignMachine } from "@/lib/vagon-api"

export async function POST() {
  try {
    const streamId = await getStreams()
    await startMachine(streamId)
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
