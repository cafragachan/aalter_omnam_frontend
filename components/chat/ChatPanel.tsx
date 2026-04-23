"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { SendHorizontal } from "lucide-react"
import { useLiveAvatarContext } from "@/lib/liveavatar/context"
import { useInputMode } from "@/lib/input-mode/context"
import { MessageSender } from "@/lib/liveavatar/types"

/**
 * Glassmorphic chat surface shown when InputMode is "chat". Reads the same
 * `messages` array the voice transcript uses, so toggling voice ↔ chat shows
 * a continuous conversation history.
 */
export function ChatPanel({ width, height }: { width: number; height: number }) {
  const { messages } = useLiveAvatarContext()
  const { sendUserText } = useInputMode()
  const [draft, setDraft] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom on new messages.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length])

  // Auto-grow textarea up to ~4 rows.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    const maxHeight = 112 // ~4 lines at 28px line-height
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [draft])

  const submit = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    sendUserText(text)
    setDraft("")
  }, [draft, sendUserText])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    },
    [submit],
  )

  return (
    <div
      className="flex flex-col overflow-hidden rounded-[16px] bg-black/30"
      style={{ width, height }}
    >
      {/* Header */}
      <div className="border-b border-white/10 px-4 py-2.5">
        <span className="text-xs uppercase tracking-[0.2em] text-white/60">Chat with Ava</span>
      </div>

      {/* Message list */}
      <div ref={listRef} className="unit-detail-scroll flex-1 space-y-2 overflow-y-auto px-3 py-3 pr-2">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-white/50">
            Say hello to Ava — type below and press Enter.
          </div>
        ) : (
          messages.map((m, i) => {
            const isUser = m.sender === MessageSender.USER
            return (
              <div
                key={`${m.timestamp}-${i}`}
                className={`flex ${isUser ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-snug ${
                    isUser
                      ? "bg-white/25 text-white"
                      : "bg-white/10 text-white/95"
                  }`}
                  style={{ fontFamily: "var(--font-open-sans)" }}
                >
                  {m.message}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-white/10 px-3 py-3">
        <div className="flex items-end gap-2 rounded-2xl border border-white/15 bg-white/10 px-3 py-2 focus-within:border-white/30">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Ava…"
            rows={1}
            className="min-h-[28px] w-full resize-none bg-transparent text-sm leading-[28px] text-white placeholder:text-white/40 outline-none"
            style={{ fontFamily: "var(--font-open-sans)" }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/30 disabled:opacity-40 disabled:hover:bg-white/20"
            title="Send"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
