import { NextResponse } from "next/server"

// Server-side proxy for HeyGen session keep-alive. The SDK's client-side
// keepAlive() hits api.liveavatar.com directly, which the browser blocks on
// CORS — so the session would idle-time-out and the avatar go silent. We proxy
// it here (no CORS server-side), authed with the session token (Bearer), same
// as the SDK's SessionAPIClient.

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
    const res = await fetch(`${apiUrl}/v1/sessions/keep-alive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    })
    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `keep-alive failed (${res.status}): ${text}` }, { status: res.status })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
