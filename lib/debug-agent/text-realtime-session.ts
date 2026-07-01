"use client"

import type { ToolHandler } from "@/lib/realtime/session"
import { formatRealtimeSkill, type RealtimeSkillId } from "@/lib/realtime/skills"

const OPENAI_WS_BASE = "wss://api.openai.com/v1/realtime"

export type TextRealtimeCallbacks = {
  onStatus?: (status: string) => void
  onLog?: (line: string) => void
  onTranscript?: (who: "user" | "ava", text: string) => void
}

type PendingReply = {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export class TextRealtimeSession {
  private cb: TextRealtimeCallbacks
  private tokenUrl: string
  private ws: WebSocket | null = null
  private toolHandler: ToolHandler | null = null
  private pendingCalls = new Map<string, { name: string; args: string }>()
  private pendingContexts: { text: string; respond: boolean }[] = []
  private avaTranscript = ""
  private pendingReply: PendingReply | null = null
  private activeResponse = false
  private pendingResponseCreate = false
  private injectedSkills = new Set<RealtimeSkillId>()

  constructor(cb: TextRealtimeCallbacks = {}, tokenUrl = "/api/realtime-token") {
    this.cb = cb
    this.tokenUrl = tokenUrl
  }

  setToolHandler(handler: ToolHandler) {
    this.toolHandler = handler
  }

  async start() {
    this.status("minting Realtime token")
    const tokRes = await fetch(this.tokenUrl, { method: "POST" })
    const tok = await tokRes.json()
    if (!tokRes.ok) throw new Error(tok.error || "realtime-token failed")

    await new Promise<void>((resolve, reject) => {
      const url = `${OPENAI_WS_BASE}?model=${encodeURIComponent(tok.model)}`
      const ws = new WebSocket(url, ["realtime", "openai-insecure-api-key." + tok.value])
      this.ws = ws
      ws.onopen = () => {
        this.log("Realtime text WS open")
        this.status("ready")
        const queued = this.pendingContexts
        this.pendingContexts = []
        for (const item of queued) this.injectContext(item.text, { respond: item.respond })
        resolve()
      }
      ws.onerror = () => reject(new Error("Realtime text WS error"))
      ws.onclose = (e) => {
        this.status("closed")
        this.log(`Realtime text WS closed (${e.code}${e.reason ? " " + e.reason : ""})`)
      }
      ws.onmessage = (ev) => this.handleMessage(ev.data as string)
    })
  }

  stop() {
    this.ws?.close()
    this.ws = null
    if (this.pendingReply) {
      clearTimeout(this.pendingReply.timeout)
      this.pendingReply.reject(new Error("session stopped"))
      this.pendingReply = null
    }
  }

  injectContext(text: string, opts: { respond?: boolean } = {}) {
    const respond = !!opts.respond
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingContexts.push({ text, respond })
      return
    }
    this.ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }),
    )
    if (respond) this.createResponseWhenIdle()
  }

  injectSkill(id: RealtimeSkillId, reason?: string, opts: { respond?: boolean; force?: boolean } = {}) {
    if (!opts.force && this.injectedSkills.has(id)) return
    this.injectedSkills.add(id)
    this.injectContext(formatRealtimeSkill(id, reason), { respond: !!opts.respond })
  }

  async sendUserText(text: string, timeoutMs = 30000): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Realtime session is not open")
    if (this.pendingReply) throw new Error("A reply is already pending")
    this.cb.onTranscript?.("user", text)
    this.avaTranscript = ""
    this.ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }),
    )
    this.createResponseWhenIdle()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReply = null
        reject(new Error("Timed out waiting for Ava response"))
      }, timeoutMs)
      this.pendingReply = { resolve, reject, timeout }
    })
  }

  private handleMessage(raw: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const type = msg.type as string

    switch (type) {
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.text.delta": {
        const delta = msg.delta as string
        if (delta) this.avaTranscript += delta
        break
      }
      case "response.created": {
        this.activeResponse = true
        break
      }
      case "response.output_item.added": {
        const item = msg.item as { type?: string; name?: string; call_id?: string } | undefined
        if (item?.type === "function_call" && item.call_id && item.name) {
          this.pendingCalls.set(item.call_id, { name: item.name, args: "" })
        }
        break
      }
      case "response.function_call_arguments.delta": {
        const callId = msg.call_id as string
        const entry = callId ? this.pendingCalls.get(callId) : undefined
        if (entry && typeof msg.delta === "string") entry.args += msg.delta
        break
      }
      case "response.function_call_arguments.done": {
        void this.runToolCall(msg.call_id as string, msg.arguments as string | undefined)
        break
      }
      case "response.done": {
        this.activeResponse = false
        const text = this.avaTranscript.trim()
        if (text) {
          this.avaTranscript = ""
          this.cb.onTranscript?.("ava", text)
          if (this.pendingReply) {
            clearTimeout(this.pendingReply.timeout)
            this.pendingReply.resolve(text)
            this.pendingReply = null
          }
        }
        if (this.pendingResponseCreate) {
          this.pendingResponseCreate = false
          this.createResponseWhenIdle()
        }
        break
      }
      case "error": {
        const detail = JSON.stringify(msg.error ?? msg)
        this.log(`Realtime text error: ${detail}`)
        if (this.pendingReply) {
          clearTimeout(this.pendingReply.timeout)
          this.pendingReply.reject(new Error(detail))
          this.pendingReply = null
        }
        break
      }
      default:
        break
    }
  }

  private async runToolCall(callId: string, finalArgs: string | undefined) {
    const entry = callId ? this.pendingCalls.get(callId) : undefined
    const name = entry?.name
    const rawArgs = finalArgs ?? entry?.args ?? "{}"
    if (callId) this.pendingCalls.delete(callId)
    if (!name) return

    let args: Record<string, unknown> = {}
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {}
    } catch {}

    let output = "ok"
    try {
      output = this.toolHandler ? await this.toolHandler(name, args) : `No handler for ${name}`
    } catch (err) {
      output = `error: ${(err as Error).message}`
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        }),
      )
      this.createResponseWhenIdle()
    }
  }

  private createResponseWhenIdle() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (this.activeResponse) {
      this.pendingResponseCreate = true
      return
    }
    this.activeResponse = true
    this.ws.send(JSON.stringify({ type: "response.create" }))
  }

  private status(s: string) {
    this.cb.onStatus?.(s)
  }

  private log(s: string) {
    this.cb.onLog?.(s)
  }
}
