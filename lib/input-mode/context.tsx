"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
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
  const { sessionRef, isMuted, appendMessage } = useLiveAvatarContext()
  const [mode, setModeState] = useState<InputMode>("voice")

  // Remember the mute state at the moment we enter chat mode so we can
  // restore it on exit. The HeyGen voiceChat is force-muted while in chat.
  const preChatMuteRef = useRef<boolean | null>(null)

  const setMode = useCallback(
    (next: InputMode) => {
      setModeState((prev) => {
        if (prev === next) return prev
        const vc = sessionRef.current?.voiceChat
        if (next === "chat") {
          preChatMuteRef.current = isMuted
          if (!isMuted) vc?.mute()
        } else {
          if (preChatMuteRef.current === false) vc?.unmute()
          preChatMuteRef.current = null
        }
        return next
      })
    },
    [isMuted, sessionRef],
  )

  const sendUserText = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      appendMessage(MessageSender.USER, trimmed)
    },
    [appendMessage],
  )

  // If the HeyGen session disconnects while we're chatting, the mute-restore
  // on exit would be a no-op. Clear the memoized pre-chat mute if the session
  // tears down so we don't accidentally call unmute on a dead session later.
  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    // No listener needed — the provider's own state-change handler will reset
    // flags naturally; this is just defensive cleanup on unmount.
    return () => {
      preChatMuteRef.current = null
    }
  }, [sessionRef])

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
