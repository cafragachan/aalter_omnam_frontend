/**
 * Server-side proxy for stopping a Vagon machine.
 *
 * Called via navigator.sendBeacon() on tab close / refresh so HMAC signing
 * happens server-side (beacon can't set custom Authorization headers).
 */

import crypto from "crypto"

const API_BASE = "https://api.vagon.io"
const API_KEY = process.env.NEXT_PUBLIC_VAGON_API_KEY ?? ""
const API_SECRET = process.env.NEXT_PUBLIC_VAGON_API_SECRET ?? ""

function generateHMAC(method: string, path: string, body = ""): string {
  const nonce = crypto.randomBytes(16).toString("hex")
  const timestamp = Date.now().toString()
  const payload = `${API_KEY}${method}${path}${timestamp}${nonce}${body}`
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(payload)
    .digest("hex")
  return `HMAC ${API_KEY}:${signature}:${nonce}:${timestamp}`
}

export async function POST(request: Request) {
  try {
    const { machine_id } = (await request.json()) as { machine_id?: string }
    if (!machine_id) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const path = "/app-stream-management/v2/streams/stop-machine"
    const bodyStr = JSON.stringify({ machine_id })
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: generateHMAC("POST", path, bodyStr),
      },
      body: bodyStr,
    })

    if (!res.ok) {
      console.error("[stop-vagon-machine] Failed:", res.status)
    } else {
      console.log("[stop-vagon-machine] Stopped machine:", machine_id)
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("[stop-vagon-machine] Error:", error)
    return new Response(
      JSON.stringify({ ok: true, error: (error as Error).message }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }
}
