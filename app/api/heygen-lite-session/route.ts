import { NextResponse } from "next/server"

// Mint a HeyGen LiveAvatar **LITE** session token. LITE = "bring your own audio":
// we stream PCM into the avatar via repeatAudio(); HeyGen only renders video +
// lip-sync. (The legacy /home path uses /api/start-sandbox-session in FULL mode —
// left untouched. This is the realtime-brain path.)

const DEFAULT_API_URL = "https://api.liveavatar.com"

// HeyGen creds live under NEXT_PUBLIC_* in this project; read server-side and
// fall back to the prefixed name (same pattern as start-sandbox-session).
const readEnv = (key: string, fallback?: string) =>
  process.env[key] ?? process.env[`NEXT_PUBLIC_${key}`] ?? fallback

export async function POST() {
  const apiKey = readEnv("HEYGEN_API_KEY")
  const avatarId = readEnv("HEYGEN_AVATAR_ID")
  const apiUrl = readEnv("HEYGEN_API_URL", DEFAULT_API_URL)!

  if (!apiKey || !avatarId) {
    return NextResponse.json(
      { error: "Missing HEYGEN_API_KEY or HEYGEN_AVATAR_ID" },
      { status: 500 },
    )
  }

  try {
    const res = await fetch(`${apiUrl}/v1/sessions/token`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "LITE",
        avatar_id: avatarId,
        is_sandbox: false,
        video_settings: { quality: "high", encoding: "VP8" },
        // Default idle timeout is ~120s, which silently kills the avatar on any
        // pause > 2min (transcript keeps going via the separate OpenAI session).
        // Raise it; client also pings keep-alive (server-side, CORS-safe).
        activity_idle_timeout: 3600,
      }),
    })

    const text = await res.text()
    if (!res.ok) {
      return NextResponse.json(
        { error: `HeyGen LITE token failed (${res.status}): ${text}` },
        { status: res.status },
      )
    }

    const data = JSON.parse(text) as {
      data?: { session_token?: string; session_id?: string }
    }
    const token = data?.data?.session_token
    if (!token) {
      return NextResponse.json(
        { error: "No session_token in HeyGen response" },
        { status: 500 },
      )
    }

    return NextResponse.json({
      session_token: token,
      session_id: data?.data?.session_id ?? null,
      api_url: apiUrl,
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
