import { buildPrompt, buildOpeningText, type ContextInput } from "@/lib/avatar-context-builder"

const DEFAULT_API_URL = "https://api.liveavatar.com"
const REQUIRED_ENV = ["HEYGEN_API_KEY", "HEYGEN_AVATAR_ID", "HEYGEN_VOICE_ID", "HEYGEN_CONTEXT_ID"]

type SessionResponse = {
  data: {
    session_token: string
    session_id: string
  }
}

type ContextResponse = {
  data: {
    id: string
  }
}

const readEnv = (key: string, fallback?: string) => process.env[key] ?? process.env[`NEXT_PUBLIC_${key}`] ?? fallback

// ---------------------------------------------------------------------------
// Create an ephemeral HeyGen context with personalized prompt + opening text
// ---------------------------------------------------------------------------

async function createEphemeralContext(
  apiUrl: string,
  apiKey: string,
  input: ContextInput,
): Promise<string | null> {
  try {
    const prompt = buildPrompt(input)
    const openingText = buildOpeningText(input)

    const res = await fetch(`${apiUrl}/v1/contexts`, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `session-${input.identity.email}-${Date.now()}`,
        prompt,
        opening_text: openingText,
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      console.error("[start-sandbox-session] Failed to create ephemeral context:", res.status, errBody)
      return null
    }

    const data = (await res.json()) as ContextResponse
    return data?.data?.id ?? null
  } catch (err) {
    console.error("[start-sandbox-session] Error creating ephemeral context:", err)
    return null
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const apiKey = readEnv("HEYGEN_API_KEY")
  const avatarId = readEnv("HEYGEN_AVATAR_ID")
  const voiceId = readEnv("HEYGEN_VOICE_ID")
  const fallbackContextId = readEnv("HEYGEN_CONTEXT_ID")
  const language = readEnv("HEYGEN_LANGUAGE", "en")
  const apiUrl = readEnv("HEYGEN_API_URL", DEFAULT_API_URL)

  const envMap: Record<string, string | undefined> = {
    HEYGEN_API_KEY: apiKey,
    HEYGEN_AVATAR_ID: avatarId,
    HEYGEN_VOICE_ID: voiceId,
    HEYGEN_CONTEXT_ID: fallbackContextId,
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
    // Parse user data from request body (optional — falls back to static context)
    let contextInput: ContextInput | null = null
    try {
      const body = await request.json()
      if (body?.identity) {
        contextInput = body as ContextInput
      }
    } catch {
      // No body or invalid JSON — proceed with fallback context
    }

    // Create ephemeral context if user data is provided
    let contextId = fallbackContextId!
    let ephemeralContextId: string | null = null

    if (contextInput) {
      const created = await createEphemeralContext(apiUrl!, apiKey!, contextInput)
      if (created) {
        contextId = created
        ephemeralContextId = created
      }
    }

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

    return new Response(
      JSON.stringify({
        session_token: sessionToken,
        session_id: sessionId,
        context_id: ephemeralContextId,
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
