"use client"

import { useCallback } from "react"
import { useLiveAvatarContext } from "./context"

export const useAvatarActions = (mode: "FULL" | "CUSTOM" = "FULL") => {
  const { sessionRef } = useLiveAvatarContext()

  const interrupt = useCallback(() => {
    return sessionRef.current?.interrupt()
  }, [sessionRef])

  const repeat = useCallback(
    async (message: string) => {
      if (!sessionRef.current) return

      console.log("[REPEAT→HeyGen]", JSON.stringify(message))

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
    [mode, sessionRef],
  )

  const startListening = useCallback(() => {
    return sessionRef.current?.startListening()
  }, [sessionRef])

  const stopListening = useCallback(() => {
    return sessionRef.current?.stopListening()
  }, [sessionRef])

  /** Send a text message to the avatar's LLM (as if the user typed it). */
  const message = useCallback(
    (text: string) => {
      sessionRef.current?.message(text)
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

