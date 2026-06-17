import { NextResponse } from "next/server"
import { buildL1Instruction } from "@/lib/realtime/context"
import { buildToolSchemas } from "@/lib/realtime/tools"

// Mint a short-lived OpenAI Realtime ephemeral client secret (ek_...). Only this
// reaches the browser; OPENAI_API_KEY never does. The L1 instruction (persona +
// distilled property dossier) is baked into the session config here — paid once
// per session, not rebuilt per turn.
//
// MANUAL path: WE own the OpenAI session in the browser, so we can tune
// turn-taking (server_vad silence window) for low-latency hands-free turns.

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2"
  const voice = process.env.OPENAI_REALTIME_VOICE || "marin"

  // Latency knobs. server_vad with a tighter silence window → less hangover
  // before Ava replies. semantic_vad is the model-based alternative.
  const vadType = process.env.OPENAI_VAD_TYPE || "server_vad"
  const silenceMs = Number(process.env.OPENAI_VAD_SILENCE_MS || "250")
  const eagerness = process.env.OPENAI_VAD_EAGERNESS || "high"

  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 })
  }

  const turn_detection =
    vadType === "semantic_vad"
      ? { type: "semantic_vad", eagerness, create_response: true }
      : { type: "server_vad", silence_duration_ms: silenceMs, create_response: true }

  const instructions = buildL1Instruction()

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "realtime",
          model,
          instructions,
          // Function calling → UE5 (executed client-side by lib/realtime/dispatcher).
          tools: buildToolSchemas(),
          tool_choice: "auto",
          // PCM16 @ 24kHz on both sides — matches HeyGen LITE, so no resampling.
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              turn_detection,
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice },
          },
        },
      }),
    })

    const text = await res.text()
    if (!res.ok) {
      return NextResponse.json(
        { error: `OpenAI client_secrets failed (${res.status}): ${text}` },
        { status: res.status },
      )
    }

    const data = JSON.parse(text) as {
      value?: string
      client_secret?: { value?: string; expires_at?: number }
    }
    const value = data?.client_secret?.value ?? data?.value
    if (!value) {
      return NextResponse.json(
        { error: "No ephemeral key (client_secret.value) in OpenAI response" },
        { status: 500 },
      )
    }

    return NextResponse.json({ value, model, vad: turn_detection })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
