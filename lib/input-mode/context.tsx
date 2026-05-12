"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { useLiveAvatarContext } from "@/lib/liveavatar/context"
import { MessageSender } from "@/lib/liveavatar/types"

export type InputMode = "voice" | "chat"

type InputModeContextProps = {
  mode: InputMode
  setMode: (mode: InputMode) => void
  /**
   * Append a user-typed message to the transcript. In chat mode this is
   * the sole input path into the orchestrator: the injected message triggers
   * the same `useJourney` user-message effect that HeyGen's USER_TRANSCRIPTION
   * event would have fired in voice mode.
   *
   * No-op in voice mode.
   */
  sendUserText: (text: string) => void
}

export const InputModeContext = createContext<InputModeContextProps | null>(null)

export function InputModeProvider({ children }: { children: ReactNode }) {
  const { sessionRef, appendMessage, setSuppressUserTranscription } = useLiveAvatarContext()
  const [mode, setModeState] = useState<InputMode>("voice")

  const setMode = useCallback(
    (next: InputMode) => {
      setModeState((prev) => {
        if (prev === next) return prev
        const vc = sessionRef.current?.voiceChat
        if (next === "chat") {
          // Gate before mute so any in-flight USER_TRANSCRIPTION lands suppressed.
          setSuppressUserTranscription(true)
          vc?.mute()
        } else {
          // Unmute before dropping the gate to avoid a window where a stale
          // transcript from the chat-mode mic stream could be appended.
          vc?.unmute()
          setSuppressUserTranscription(false)
        }
        return next
      })
    },
    [sessionRef, setSuppressUserTranscription],
  )

  const sendUserText = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      appendMessage(MessageSender.USER, trimmed)
    },
    [appendMessage],
  )

  const value = useMemo(
    () => ({ mode, setMode, sendUserText }),
    [mode, setMode, sendUserText],
  )

  return <InputModeContext.Provider value={value}>{children}</InputModeContext.Provider>
}

export function useInputMode() {
  const ctx = useContext(InputModeContext)
  if (!ctx) {
    throw new Error("useInputMode must be used within an InputModeProvider")
  }
  return ctx
}
