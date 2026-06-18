import { NextResponse } from "next/server"

// Server-side proxy for HeyGen session stop. The SDK's client-side stop() hits
// api.liveavatar.com directly (CORS-blocked in the browser), so sessions never
// get cleanly stopped and pile up against the concurrent-session limit. We proxy
// it here, authed with the session token (Bearer).

const DEFAULT_API_URL = "https://api.liveavatar.com"
const readEnv = (key: string, fallback?: string) =>
  process.env[key] ?? process.env[`NEXT_PUBLIC_${key}`] ?? fallback

export async function POST(req: Request) {
  const apiUrl = readEnv("HEYGEN_API_URL", DEFAULT_API_URL)!
  let sessionToken: string | undefined
  try {
    sessionToken = (await req.json())?.session_token
  } catch {
    /* no body */
  }
  if (!sessionToken) {
    return NextResponse.json({ error: "Missing session_token" }, { status: 400 })
  }

  try {
    const res = await fetch(`${apiUrl}/v1/sessions/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    })
    // Treat a non-OK stop as best-effort — the session may already be gone.
    return NextResponse.json({ ok: res.ok, status: res.status })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
