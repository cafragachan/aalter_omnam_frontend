/**
 * Server-side proxy for stopping a Vagon machine.
 *
 * Called via navigator.sendBeacon() on tab close / refresh so HMAC signing
 * happens server-side (beacon can't set custom Authorization headers).
 */

import { stopMachine } from "@/lib/vagon-api"

export async function POST(request: Request) {
  try {
    const { machine_id } = (await request.json()) as { machine_id?: string }
    if (!machine_id) {
      return Response.json({ ok: true, skipped: true })
    }

    await stopMachine(machine_id)
    console.log("[stop-vagon-machine] Stopped machine:", machine_id)

    return Response.json({ ok: true })
  } catch (error) {
    console.error("[stop-vagon-machine] Error:", error)
    return Response.json({ ok: true, error: (error as Error).message })
  }
}
