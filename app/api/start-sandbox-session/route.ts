const DEFAULT_API_URL = "https://api.liveavatar.com"
const REQUIRED_ENV = ["HEYGEN_API_KEY", "HEYGEN_AVATAR_ID", "HEYGEN_VOICE_ID", "HEYGEN_CONTEXT_ID"]

type SessionResponse = {
  data: {
    session_token: string
    session_id: string
  }
}

const readEnv = (key: string, fallback?: string) => process.env[key] ?? process.env[`NEXT_PUBLIC_${key}`] ?? fallback

export async function POST() {
  const apiKey = readEnv("HEYGEN_API_KEY")
  const avatarId = readEnv("HEYGEN_AVATAR_ID")
  const voiceId = readEnv("HEYGEN_VOICE_ID")
  const contextId = readEnv("HEYGEN_CONTEXT_ID")
  const language = readEnv("HEYGEN_LANGUAGE", "en")
  const apiUrl = readEnv("HEYGEN_API_URL", DEFAULT_API_URL)

  const envMap: Record<string, string | undefined> = {
    HEYGEN_API_KEY: apiKey,
    HEYGEN_AVATAR_ID: avatarId,
    HEYGEN_VOICE_ID: voiceId,
    HEYGEN_CONTEXT_ID: contextId,
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
          context_id: contextId,
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

    return new Response(JSON.stringify({ session_token: sessionToken, session_id: sessionId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
