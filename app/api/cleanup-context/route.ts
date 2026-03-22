const DEFAULT_API_URL = "https://api.liveavatar.com"

const readEnv = (key: string, fallback?: string) => process.env[key] ?? process.env[`NEXT_PUBLIC_${key}`] ?? fallback

export async function POST(request: Request) {
  const apiKey = readEnv("HEYGEN_API_KEY")
  const apiUrl = readEnv("HEYGEN_API_URL", DEFAULT_API_URL)

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing HEYGEN_API_KEY" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    const { context_id } = (await request.json()) as { context_id?: string }
    if (!context_id) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    const res = await fetch(`${apiUrl}/v1/contexts/${context_id}`, {
      method: "DELETE",
      headers: { "X-API-KEY": apiKey },
    })

    if (!res.ok) {
      console.error("[cleanup-context] Failed to delete context:", context_id, res.status)
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("[cleanup-context] Error:", error)
    // Non-critical — always return 200 to avoid blocking the client
    return new Response(JSON.stringify({ ok: true, error: (error as Error).message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
}
