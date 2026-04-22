import { getHotelCatalog } from "@/lib/hotel-data"

const DEFAULT_API_URL = "https://api.liveavatar.com"
const REQUIRED_ENV = ["HEYGEN_API_KEY", "HEYGEN_AVATAR_ID", "HEYGEN_VOICE_ID"]

// The pilot/active hotel — matches the `PILOT_HOTEL` constant inside
// journey-machine.ts. Kept as a module-level string here (rather than a new
// export from journey-machine) so the session bootstrap endpoint doesn't pull
// the reducer module into its import graph.
const PILOT_HOTEL_SLUG = "edition-lake-como"

type SessionResponse = {
  data: {
    session_token: string
    session_id: string
  }
}

const readEnv = (key: string, fallback?: string) => process.env[key] ?? process.env[`NEXT_PUBLIC_${key}`] ?? fallback

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST() {
  const apiKey = readEnv("HEYGEN_API_KEY")
  const avatarId = readEnv("HEYGEN_AVATAR_ID")
  const voiceId = readEnv("HEYGEN_VOICE_ID")
  const language = readEnv("HEYGEN_LANGUAGE", "en")
  const apiUrl = readEnv("HEYGEN_API_URL", DEFAULT_API_URL)

  const envMap: Record<string, string | undefined> = {
    HEYGEN_API_KEY: apiKey,
    HEYGEN_AVATAR_ID: avatarId,
    HEYGEN_VOICE_ID: voiceId,
  }

  const missing = REQUIRED_ENV.filter((key) => !envMap[key])
  if (missing.length) {
    return new Response(
      JSON.stringify({
        error: `Missing required HeyGen environment variables: ${missing.join(", ")}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    // Request session token from HeyGen
    const res = await fetch(`${apiUrl}/v1/sessions/token`, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "FULL",
        avatar_id: avatarId,
        is_sandbox: false,
        avatar_persona: {
          voice_id: voiceId,
          language,
        },
      }),
    })

    if (!res.ok) {
      let message = "Failed to retrieve session token"
      try {
        const payload = (await res.json()) as unknown
        const payloadObj = payload as { error?: string; message?: string; data?: unknown }

        const dataMessage = Array.isArray(payloadObj?.data)
          ? (payloadObj.data[0] as { message?: string } | undefined)?.message
          : undefined

        message = dataMessage ?? payloadObj?.message ?? payloadObj?.error ?? message
      } catch {
        // ignore parse issues
      }

      return new Response(JSON.stringify({ error: message }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      })
    }

    const data = (await res.json()) as SessionResponse
    const sessionToken = data?.data?.session_token
    const sessionId = data?.data?.session_id

    if (!sessionToken) {
      return new Response(JSON.stringify({ error: "Session token missing from HeyGen response" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Phase 2: ship the hotel catalog for the active (pilot) property alongside
    // the session token. Additive — clients that don't read `catalog` keep
    // working. When the slug is unknown, emit `null` so the consumer can fall
    // back to the client-side `getAmenitiesByHotelId`/`getRoomsByHotelId`
    // helpers without special-casing missing fields.
    const catalog = getHotelCatalog(PILOT_HOTEL_SLUG)

    return new Response(
      JSON.stringify({
        session_token: sessionToken,
        session_id: sessionId,
        catalog,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
