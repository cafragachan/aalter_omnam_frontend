"use client"

import { useCallback, useContext } from "react"
import { useLiveAvatarContext } from "./context"
import { MessageSender } from "./types"
import { InputModeContext } from "@/lib/input-mode/context"

export const useAvatarActions = (mode: "FULL" | "CUSTOM" = "FULL") => {
  const { sessionRef, appendMessage } = useLiveAvatarContext()
  // Read the InputMode context directly (not via the throwing hook) so that
  // `useAvatarActions` remains callable even outside an InputModeProvider.
  // When no provider is present, we default to voice-mode behavior.
  const inputMode = useContext(InputModeContext)
  const isChatMode = inputMode?.mode === "chat"

  const interrupt = useCallback(() => {
    if (isChatMode) return
    return sessionRef.current?.interrupt()
  }, [isChatMode, sessionRef])

  const repeat = useCallback(
    async (message: string) => {
      if (!sessionRef.current) return

      console.log("[REPEAT→HeyGen]", JSON.stringify(message))

      // Chat mode: don't call HeyGen TTS. Just append the avatar turn to the
      // transcript so the chat UI shows it and downstream consumers (persistence,
      // useJourney's AVATAR message read-path, etc.) see the same shape as a
      // voice-mode AVATAR_TRANSCRIPTION event.
      if (isChatMode) {
        appendMessage(MessageSender.AVATAR, message)
        return
      }

      if (mode === "FULL") {
        return sessionRef.current.repeat(message)
      }

      const res = await fetch("/api/elevenlabs-text-to-speech", {
        method: "POST",
        body: JSON.stringify({ text: message }),
      })
      const { audio } = await res.json()
      return sessionRef.current.repeatAudio(audio)
    },
    [appendMessage, isChatMode, mode, sessionRef],
  )

  const startListening = useCallback(() => {
    if (isChatMode) return
    return sessionRef.current?.startListening()
  }, [isChatMode, sessionRef])

  const stopListening = useCallback(() => {
    if (isChatMode) return
    return sessionRef.current?.stopListening()
  }, [isChatMode, sessionRef])

  /** Send a text message to the avatar's LLM (as if the user typed it). */
  const message = useCallback(
    (text: string) => {
      if (isChatMode) return
      sessionRef.current?.message(text)
    },
    [isChatMode, sessionRef],
  )

  return {
    interrupt,
    repeat,
    startListening,
    stopListening,
    message,
  }
}
