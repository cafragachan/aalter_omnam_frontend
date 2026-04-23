"use client"

import { useCallback } from "react"
import { MessageSquare, Mic } from "lucide-react"
import { useInputMode } from "@/lib/input-mode/context"

/**
 * Toggles between voice (HeyGen avatar + STT/TTS) and chat (text-only)
 * modes. Same visual treatment as MicToggle — sits directly below it in
 * the avatar control column.
 */
export function ModeToggle() {
  const { mode, setMode } = useInputMode()
  const isChat = mode === "chat"

  const toggle = useCallback(() => {
    setMode(isChat ? "voice" : "chat")
  }, [isChat, setMode])

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 backdrop-blur-md shadow-lg transition-colors hover:bg-white/20"
      title={isChat ? "Switch to voice" : "Switch to chat"}
    >
      {isChat ? (
        <Mic className="h-5 w-5 text-white" />
      ) : (
        <MessageSquare className="h-5 w-5 text-white" />
      )}
    </button>
  )
}
