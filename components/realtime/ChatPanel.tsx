"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { SendHorizontal } from "lucide-react"

export type ChatMessage = { who: "user" | "ava"; text: string; timestamp: number }

/**
 * Text transcript + composer shown in the avatar pill's slot when the guest
 * toggles to chat mode (substitutes the rendered avatar). Pure view: it reads a
 * `messages` array and calls `onSend`. The realtime session — and its server-side
 * conversation memory — live ABOVE this component, and the avatar <video> stays
 * mounted off-screen, so toggling voice ↔ chat never loses history. Voice turns
 * and typed turns interleave into the same `messages` array.
 */
export function ChatPanel({
  messages,
  onSend,
  width,
  height,
}: {
  messages: ChatMessage[]
  onSend: (text: string) => void
  width: number
  height: number
}) {
  const [draft, setDraft] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  // Auto-grow the composer up to ~3 lines.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 126)}px`
  }, [draft])

  const submit = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft("")
  }, [draft, onSend])

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
    <div className="flex flex-col overflow-hidden rounded-[16px] bg-black/40" style={{ width, height }}>
      <div className="border-b border-white/10 px-4 py-2">
        <span className="text-[11px] uppercase tracking-[0.2em] text-white/60">Chat with Ava</span>
      </div>

      <div ref={listRef} className="unit-detail-scroll flex-1 space-y-2 overflow-y-auto px-3 py-3 pr-1">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-white/50">
            Type below and press Enter to chat with Ava.
          </div>
        ) : (
          messages.map((m, i) => {
            const isUser = m.who === "user"
            return (
              <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-snug ${
                    isUser ? "bg-white/25 text-white" : "bg-white/10 text-white/95"
                  }`}
                  style={{ fontFamily: "var(--font-open-sans)" }}
                >
                  {m.text}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-white/10 px-3 py-2.5">
        <div className="flex items-end gap-2 rounded-2xl border border-white/15 bg-white/10 px-3 py-1.5 focus-within:border-white/30">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Ava…"
            rows={1}
            className="unit-detail-scroll min-h-[24px] w-full resize-none bg-transparent text-sm leading-[24px] text-white placeholder:text-white/40 outline-none"
            style={{ fontFamily: "var(--font-open-sans)" }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/30 disabled:opacity-40"
            title="Send"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
