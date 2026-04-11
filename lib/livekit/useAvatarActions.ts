"use client"

// Stage 3 of the HeyGen → LiveKit migration.
//
// Mirrors the return shape of lib/liveavatar/useAvatarActions.ts line-for-line:
//   { interrupt, repeat, startListening, stopListening, message }
//
// Under the hood every action publishes a data-channel message to the
// agent, which already handles these types (see agent/index.ts Stage 2
// DataReceived handler: "speak", "interrupt", "user_message").

import { useCallback } from "react"
import { useLiveKitAvatarContext } from "./context"
import { publishMessage } from "./data-channel"

/**
 * @param mode — accepted for signature compatibility with the legacy
 *   hook. Legacy used "CUSTOM" to route repeat() through an ElevenLabs
 *   TTS endpoint; the LiveKit path delegates TTS to the agent's
 *   RealtimeModel, so both "FULL" and "CUSTOM" behave identically here.
 *   The parameter is kept so Stage 5's page.tsx import doesn't need to
 *   drop the argument.
 */
export const useAvatarActions = (_mode: "FULL" | "CUSTOM" = "FULL") => {
  const { sessionRef } = useLiveKitAvatarContext()

  const interrupt = useCallback(() => {
    const room = sessionRef.current
    if (!room) return
    return publishMessage(room, { type: "interrupt" })
  }, [sessionRef])

  const repeat = useCallback(
    async (text: string) => {
      const room = sessionRef.current
      if (!room) return
      await publishMessage(room, { type: "speak", text })
    },
    [sessionRef],
  )

  const startListening = useCallback(async () => {
    const room = sessionRef.current
    if (!room) return
    try {
      await room.localParticipant.setMicrophoneEnabled(true)
    } catch (err) {
      console.error("[livekit] startListening failed:", err)
    }
  }, [sessionRef])

  const stopListening = useCallback(async () => {
    const room = sessionRef.current
    if (!room) return
    try {
      await room.localParticipant.setMicrophoneEnabled(false)
    } catch (err) {
      console.error("[livekit] stopListening failed:", err)
    }
  }, [sessionRef])

  /** Send a typed message to the avatar's LLM (as if the user typed it). */
  const message = useCallback(
    (text: string) => {
      const room = sessionRef.current
      if (!room) return
      publishMessage(room, { type: "user_message", text }).catch((err) =>
        console.error("[livekit] user_message publish failed:", err),
      )
    },
    [sessionRef],
  )

  return {
    interrupt,
    repeat,
    startListening,
    stopListening,
    message,
  }
}
