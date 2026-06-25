// RealtimeSession — the new brain. One persistent gpt-realtime speech-to-speech
// session (manual WS, browser-owned) feeding PCM into HeyGen LITE.
//
//   mic ──(AudioWorklet PCM16@24k)──▶ OpenAI Realtime WS (input_audio_buffer.append)
//                                        │  server VAD detects end-of-speech
//                                        ▼
//                            response.output_audio.delta (base64 PCM16@24k)
//                                        ▼
//                        HeyGen LITE session.repeatAudio(base64) ──▶ avatar lip-syncs
//
// Ported from the validated spike (heygen-lite-realtime-spike). Additions for the
// product path: a tool-call handler (function calling → UE5, wired in Phase A.2)
// and injectContext() for situational deltas (L3). Instructions (L1 persona +
// distilled catalog) are baked into the ephemeral token server-side.
//
// Instrumentation (performance.now(), one monotonic clock):
//   t0 = input_audio_buffer.speech_stopped   t1 = first output_audio.delta
//   t2 = first repeatAudio()                  t3 = first avatar.speak_started

import {
  LiveAvatarSession,
  SessionEvent,
  SessionState,
  SessionDisconnectReason,
  AgentEventsEnum,
} from "@heygen/liveavatar-web-sdk"

export interface TurnMetric {
  turn: number
  t0: number
  t1: number | null
  t2: number | null
  t3: number | null
  realtimeMs: number | null
  bridgeMs: number | null
  heygenMs: number | null
  e2eMs: number | null
}

export interface RealtimeCallbacks {
  onStatus?: (status: string) => void
  onLog?: (line: string) => void
  onMetric?: (metric: TurnMetric) => void
  onTranscript?: (who: "user" | "ava", text: string) => void
  /** Fired once Ava has spoken her end-of-experience farewell (and the buffered
   *  HeyGen audio has played out), so the UI can tear the session down and show
   *  the send-off overlay. Armed by beginClose(). */
  onFarewellSpoken?: () => void
}

export interface RealtimeOptions {
  /** Server route that mints a HeyGen LITE session token. */
  heygenUrl?: string
  /** Server route that mints the OpenAI Realtime ephemeral token. */
  tokenUrl?: string
  /** Fire ONE proactive greeting ~3s after the avatar + WS are ready, instead
   *  of waiting for the guest to speak. Content is driven by persona + hydration. */
  greetOnReady?: boolean
}

/**
 * A tool-call handler. Receives the function name + parsed args, executes the
 * action (e.g. a UE5 navigation), and returns a short string result that is sent
 * back to the model as the function_call_output. Registered in Phase A.2.
 */
export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string> | string

const OPENAI_WS_BASE = "wss://api.openai.com/v1/realtime"

// Small delay before the one-shot greeting once the avatar + WS are both ready.
// Just enough headroom for the avatar to accept repeatAudio; kept short so Ava
// starts talking quickly.
const GREET_DELAY_MS = 200

// Brief mic-suppression window at the ONSET of each avatar utterance — long
// enough to swallow the echo spike before browser AEC adapts, short enough that
// the guest can still barge in mid-sentence. (Not extended per audio chunk, so it
// no longer gates the whole utterance — that's what blocked interruption.)
const SELF_ECHO_GUARD_MS = 300

// Avatar speak watchdog. We push audio into HeyGen via repeatAudio(), then expect
// an AVATAR_SPEAK_STARTED back. HeyGen can stop rendering while still reporting
// CONNECTED (idle/duration/credit limits, or a wedged audio queue) — and the SDK
// fires NO SESSION_DISCONNECTED for that, so our normal reconnect never trips. If
// no speak-started lands within this window after we push audio, we treat the
// avatar as stalled and force a reconnect. Generous vs normal render latency
// (which follows the pushed chunk by a few hundred ms) to avoid false positives.
const SPEAK_WATCHDOG_MS = 3000

// End-of-experience: after Ava's farewell response completes, wait this long for
// HeyGen to finish playing the buffered audio before tearing down (analog of the
// old 4s STOP_AVATAR delay).
const FAREWELL_TAIL_MS = 3500
// Safety net: if no spoken farewell ever completes (e.g. an empty response),
// close anyway so the guest is never stranded mid-goodbye.
const CLOSE_FALLBACK_MS = 12000

export class RealtimeSession {
  private videoEl: HTMLMediaElement
  private cb: RealtimeCallbacks
  private opts: Required<RealtimeOptions>

  private avatar: LiveAvatarSession | null = null
  private oaWs: WebSocket | null = null
  private audioCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private workletNode: AudioWorkletNode | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private sinkGain: GainNode | null = null

  private running = false
  private avatarReady = false
  private turnCounter = 0
  private cur: TurnMetric | null = null

  // Avatar speak liveness. avatarSpeaking tracks whether HeyGen is currently
  // rendering audio (from AVATAR_SPEAK_STARTED/ENDED); the watchdog catches the
  // "we pushed audio but the avatar never spoke" stall that fires no disconnect
  // event. Counts are cumulative instrumentation so a stall log can show e.g.
  // "pushed 42 chunks, 0 speak_started".
  private avatarSpeaking = false
  private speakWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  private repeatAudioCount = 0
  private speakStartedCount = 0

  // Outgoing-to-HeyGen coalescing buffer (raw PCM bytes; base64-encoded at flush).
  private pcmBytes = ""
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private firstFlushDone = false
  private avaTranscript = ""

  // Tool calling (Phase A.2). callId → accumulated state.
  private toolHandler: ToolHandler | null = null
  private pendingCalls = new Map<string, { name: string; args: string }>()
  // Context items injected before the WS is open are queued and flushed on open
  // (so returning-guest hydration at session start isn't dropped).
  private pendingContext: { text: string; respond: boolean }[] = []

  // HeyGen session lifecycle. The avatar idle-times-out (and the browser can't
  // keep-alive/stop it — CORS), so we ping keep-alive + stop via server proxies
  // and reconnect if the LITE session drops while the OpenAI session lives on.
  private heygenSessionToken: string | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false
  private reconnectAttempts = 0
  // OpenAI Realtime WS reconnect (mirrors the HeyGen avatar reconnect). An
  // unexpected socket close — network blip, server-side drop, session timeout —
  // would otherwise leave the avatar up but the brain permanently dead (the exact
  // "started but never replied" symptom). Bounded so a hard failure can't spin.
  private oaReconnectAttempts = 0
  // One-shot proactive greeting (~3s after avatar + WS are ready).
  private greeted = false
  private greetTimer: ReturnType<typeof setTimeout> | null = null
  // Anti-echo: while Ava is speaking (+tail), don't forward mic audio to OpenAI,
  // so her own voice can't re-trigger VAD and make her respond/greet twice.
  private outputActiveUntil = 0
  // Mic mute (user toggle + chat mode). When true, captured PCM is dropped before
  // it reaches OpenAI (server VAD never fires), so the guest can talk freely.
  private micMuted = false
  // Whether an OpenAI response is currently generating — so a barge-in only sends
  // response.cancel when there's actually something to cancel.
  private responseActive = false
  // Whether the active response is producing a function call. We must NOT cancel
  // those on barge-in: canceling before function_call_arguments.done drops the
  // tool action (e.g. view_unit), so commands like "show me the penthouse" while
  // Ava acks would silently never execute.
  private responseHasFunctionCall = false
  // End-of-experience close: set by beginClose(). The next SPOKEN response to
  // complete (Ava's farewell) fires onFarewellSpoken after a tail; a fallback
  // timer guarantees the close even if she says nothing.
  private closeRequested = false
  private closeFallbackTimer: ReturnType<typeof setTimeout> | null = null

  constructor(videoEl: HTMLMediaElement, cb: RealtimeCallbacks = {}, opts: RealtimeOptions = {}) {
    this.videoEl = videoEl
    this.cb = cb
    this.opts = {
      heygenUrl: opts.heygenUrl ?? "/api/heygen-lite-session",
      tokenUrl: opts.tokenUrl ?? "/api/realtime-token",
      greetOnReady: opts.greetOnReady ?? false,
    }
  }

  /** Register the tool-call handler (function calling → UE5). */
  setToolHandler(handler: ToolHandler) {
    this.toolHandler = handler
  }

  /** Mute/unmute the guest mic. Muted → captured PCM is dropped before it reaches
   *  OpenAI (server VAD never fires), and the track is disabled so the browser
   *  shows the mic as off. Used by the mic button and by chat (text-only) mode. */
  setMicMuted(muted: boolean) {
    this.micMuted = muted
    try {
      this.micStream?.getAudioTracks().forEach((t) => {
        t.enabled = !muted
      })
    } catch {}
  }

  setMicrophoneMuted(muted: boolean) {
    this.setMicMuted(muted)
  }

  isMicrophoneMuted() {
    return this.micMuted
  }

  /** Begin the end-of-experience close. Mutes the mic immediately so the guest
   *  can't barge in over Ava's goodbye, and arranges for onFarewellSpoken to fire
   *  once she has finished speaking it (or after a fallback, if she says nothing).
   *  Idempotent — a second call while already closing is a no-op. */
  beginClose() {
    if (this.closeRequested) return
    this.closeRequested = true
    this.setMicMuted(true)
    this.closeFallbackTimer = setTimeout(() => {
      if (!this.closeRequested) return
      this.closeRequested = false
      this.closeFallbackTimer = null
      this.cb.onFarewellSpoken?.()
    }, CLOSE_FALLBACK_MS)
  }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    if (this.running) return
    this.running = true
    this.stopping = false
    this.reconnectAttempts = 0
    this.oaReconnectAttempts = 0
    this.greeted = false
    this.avatarSpeaking = false
    this.responseActive = false
    // Start the avatar and the mic/Realtime CONCURRENTLY: the OpenAI WS connects
    // while the HeyGen avatar is still negotiating WebRTC, instead of back-to-back
    // (which added ~1s+ before Ava's first word). Avatar failure is fatal; a
    // mic/permission failure must NOT tear the avatar down (it left a black
    // thumbnail), so the mic path swallows its own error. maybeGreet fires from
    // whichever of the two finishes last, so order of completion doesn't matter.
    const avatarP = this.startAvatar()
    const micP = this.startRealtimeAndMic().catch((err) => {
      if (this.superseded()) return
      this.log(`⚠️ [OpenAI] mic/realtime start failed (avatar stays up): ${(err as Error).message}`)
      this.status("avatar ready — voice unavailable")
    })
    // Avatar — fatal on failure. stop() may also have fired mid-flight (React
    // StrictMode mount→cleanup→mount): abandon and release what we created.
    try {
      await avatarP
    } catch (err) {
      if (this.superseded()) return void (await this.teardown())
      this.log(`❌ [HeyGen] avatar start failed: ${(err as Error).message}`)
      this.status("error")
      await this.stop()
      return
    }
    if (this.superseded()) return void (await this.teardown())
    await micP // already error-handled above; just await completion
    if (this.superseded()) return void (await this.teardown())
    this.status("LIVE — speak to Ava")
  }

  /** True when this startup has been cancelled (stop() ran) mid-flight — any
   *  async start step that sees this must bail and release what it created. */
  private superseded(): boolean {
    return this.stopping || !this.running
  }

  async stop() {
    this.running = false
    this.stopping = true
    this.avatarReady = false
    await this.teardown()
    this.status("stopped")
  }

  /**
   * Release every live resource. Idempotent (null-guards + try/catch), so it's
   * safe to call from stop() AND from an aborted start() that discovered it had
   * been superseded mid-flight. Deliberately does NOT touch running/stopping —
   * the caller owns the lifecycle flags.
   */
  private async teardown() {
    this.stopKeepAlive()
    this.clearSpeakWatchdog()
    this.avatarSpeaking = false
    if (this.greetTimer) {
      clearTimeout(this.greetTimer)
      this.greetTimer = null
    }
    if (this.closeFallbackTimer) {
      clearTimeout(this.closeFallbackTimer)
      this.closeFallbackTimer = null
    }
    // Stop the HeyGen session server-side (browser REST stop is CORS-blocked).
    if (this.heygenSessionToken) void this.serverStop(this.heygenSessionToken)
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      this.workletNode?.disconnect()
      this.sinkGain?.disconnect()
      this.sourceNode?.disconnect()
    } catch {}
    try {
      this.micStream?.getTracks().forEach((t) => t.stop())
    } catch {}
    try {
      await this.audioCtx?.close()
    } catch {}
    try {
      this.oaWs?.close()
    } catch {}
    try {
      await this.avatar?.stop()
    } catch {}
    this.workletNode = null
    this.sinkGain = null
    this.sourceNode = null
    this.micStream = null
    this.audioCtx = null
    this.oaWs = null
    this.avatar = null
    this.heygenSessionToken = null
    this.pendingCalls.clear()
  }

  /**
   * L3 — inject a small situational note as a conversation item (e.g. a scene
   * change). `respond: true` makes Ava react out loud immediately (proactive
   * narration); otherwise it just updates her awareness for the next turn.
   */
  injectContext(text: string, opts: { respond?: boolean } = {}) {
    if (this.oaWs && this.oaWs.readyState === WebSocket.OPEN) {
      this.sendContext(text, !!opts.respond)
    } else {
      this.pendingContext.push({ text, respond: !!opts.respond })
    }
  }

  private sendContext(text: string, respond: boolean) {
    if (!this.oaWs || this.oaWs.readyState !== WebSocket.OPEN) return
    this.oaWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }),
    )
    if (respond) this.oaWs.send(JSON.stringify({ type: "response.create" }))
  }

  // ---- HeyGen LITE avatar -----------------------------------------------

  private async startAvatar() {
    this.status("minting HeyGen LITE session…")
    const res = await fetch(this.opts.heygenUrl, { method: "POST" })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || "heygen-lite-session failed")
    this.heygenSessionToken = json.session_token
    // Superseded while minting? Bail BEFORE creating/attaching the avatar (the
    // token is set, so teardown() will serverStop it). Prevents a stopped
    // session from grabbing the shared <video> element out from under the new one.
    if (this.superseded()) return

    const avatar = new LiveAvatarSession(json.session_token, {
      voiceChat: false, // BYO audio — we push PCM via repeatAudio()
      apiUrl: json.api_url,
    })
    this.avatar = avatar

    avatar.on(SessionEvent.SESSION_STATE_CHANGED, (state: SessionState) => {
      this.log(`[HeyGen] avatar state: ${state}`)
    })
    avatar.on(SessionEvent.SESSION_STREAM_READY, () => {
      this.log("[HeyGen] avatar stream ready → attaching")
      this.reconnectAttempts = 0 // healthy connection — refresh the retry budget
      try {
        avatar.attach(this.videoEl)
        ;(this.videoEl as HTMLVideoElement).muted = false
        void (this.videoEl as HTMLVideoElement).play().catch(() => {})
      } catch (err) {
        this.log(`❌ [HeyGen] attach failed: ${(err as Error).message}`)
      }
    })
    avatar.on(SessionEvent.SESSION_DISCONNECTED, (reason: SessionDisconnectReason) => {
      void this.handleAvatarDisconnect(reason)
    })
    avatar.on(SessionEvent.SESSION_CONNECTION_QUALITY_CHANGED, (quality) => {
      this.log(`[HeyGen] connection quality: ${quality}`)
    })
    avatar.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
      // The avatar actually started rendering — it's alive. Clear the stall
      // watchdog and mark it speaking (so barge-in knows there's something to cut).
      this.speakStartedCount += 1
      this.avatarSpeaking = true
      this.clearSpeakWatchdog()
      this.outputActiveUntil = Date.now() + SELF_ECHO_GUARD_MS // brief onset-only echo guard
      if (this.cur && this.cur.t3 == null) {
        this.cur.t3 = performance.now()
        this.finalizeTurn()
      }
    })
    avatar.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
      this.avatarSpeaking = false
    })
    // NB: Ava's transcript is emitted once per turn from `response.done`
    // (the OpenAI-side text), NOT from HeyGen AVATAR_TRANSCRIPTION — wiring both
    // would double every avatar bubble in the chat transcript.

    this.status("connecting avatar…")
    await avatar.start()
    if (this.superseded()) return // stop() raced us — teardown() will drop this avatar
    this.avatarReady = true
    this.startKeepAlive()
    this.maybeGreet()
    this.log("✅ [HeyGen] avatar connected (LITE, BYO audio)")
  }

  // One proactive greeting as soon as BOTH the avatar and the WS are ready, so Ava
  // welcomes the guest instead of waiting for them to speak first. Called from both
  // ready-paths (avatar connected / WS open); whichever lands last triggers it.
  private maybeGreet() {
    if (!this.opts.greetOnReady || this.greeted || this.greetTimer) return
    if (!this.avatarReady) return
    if (!this.oaWs || this.oaWs.readyState !== WebSocket.OPEN) return
    // Claim the one-shot NOW (not when the timer fires) so the other ready-path
    // can't double-schedule a second welcome. stop()/teardown clears greetTimer,
    // so an aborted session still never greets.
    this.greeted = true
    this.greetTimer = setTimeout(() => {
      this.greetTimer = null
      this.injectContext(
        "[Begin now — give a brief, warm welcome (for a first-time guest, note this is an early demo of the EDITION Lake Como, with more hotels coming), then ask ONLY for their travel dates. Don't ask anything else yet.]",
        { respond: true },
      )
    }, GREET_DELAY_MS)
  }

  // ---- HeyGen session lifecycle (server-proxied; CORS-safe) -------------

  private startKeepAlive() {
    this.stopKeepAlive()
    const token = this.heygenSessionToken
    if (!token) return
    // Ping well inside the idle window so the avatar never goes silent.
    this.keepAliveTimer = setInterval(() => {
      void fetch("/api/heygen-keepalive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: token }),
      }).catch(() => {})
    }, 60_000)
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private async serverStop(token: string) {
    try {
      await fetch("/api/heygen-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: token }),
      })
    } catch {}
  }

  private async handleAvatarDisconnect(reason: SessionDisconnectReason) {
    if (this.stopping || !this.running) return
    this.stopKeepAlive()
    if (this.reconnectAttempts >= 2) {
      this.log(`⚠️ [HeyGen] avatar disconnected (${reason}); gave up after ${this.reconnectAttempts} reconnect attempts`)
      this.status("avatar disconnected")
      return
    }
    this.reconnectAttempts += 1
    this.log(`↻ [HeyGen] avatar disconnected (${reason}); reconnecting (attempt ${this.reconnectAttempts})…`)
    if (this.heygenSessionToken) void this.serverStop(this.heygenSessionToken)
    try {
      await this.avatar?.stop()
    } catch {}
    this.avatar = null
    try {
      await this.startAvatar() // re-mint + re-create + re-attach + restart keep-alive
      this.log("✅ [HeyGen] avatar reconnected")
    } catch (err) {
      this.log(`❌ [HeyGen] avatar reconnect failed: ${(err as Error).message}`)
    }
  }

  // ---- OpenAI Realtime + mic --------------------------------------------

  private async startRealtimeAndMic() {
    const tok = await this.mintRealtimeToken()
    if (this.superseded()) return // stopped mid-startup — don't grab the mic
    this.log(`🧠 [OpenAI] model ${tok.model}, VAD ${JSON.stringify(tok.vad)}`)

    // Mic capture at 24kHz so no resampling is needed.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (this.superseded()) return // teardown() stops the tracks we just acquired
    const ctx = new AudioContext({ sampleRate: 24000 })
    this.audioCtx = ctx
    if (ctx.state === "suspended") await ctx.resume()
    if (ctx.sampleRate !== 24000) {
      this.log(`⚠️ AudioContext is ${ctx.sampleRate}Hz, not 24000Hz — input may need resampling`)
    }
    await ctx.audioWorklet.addModule("/pcm-recorder-worklet.js")
    if (this.superseded()) return // teardown() closes the ctx we just built
    this.sourceNode = ctx.createMediaStreamSource(this.micStream)
    this.workletNode = new AudioWorkletNode(ctx, "pcm-recorder")
    // The worklet needs a path to ctx.destination or Chrome won't run process().
    // Route through a muted gain so nothing is audible.
    this.sinkGain = ctx.createGain()
    this.sinkGain.gain.value = 0
    this.sourceNode.connect(this.workletNode)
    this.workletNode.connect(this.sinkGain)
    this.sinkGain.connect(ctx.destination)

    this.workletNode.port.onmessage = (ev: MessageEvent) => {
      // Mic mute (user toggle / chat mode): drop everything before it leaves.
      if (this.micMuted) return
      // Brief echo guard at each utterance's ONSET only (see SELF_ECHO_GUARD_MS);
      // the rest of Ava's speech flows through so the guest can barge in.
      if (Date.now() < this.outputActiveUntil) return
      const buf = ev.data as ArrayBuffer
      if (this.oaWs && this.oaWs.readyState === WebSocket.OPEN) {
        const b64 = arrayBufferToBase64(buf)
        this.oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }))
      }
    }

    // Browser-direct Realtime WS; ephemeral key in the subprotocol.
    this.openRealtimeWs(tok.model, tok.value)
  }

  /** Mint a fresh OpenAI Realtime ephemeral token. Used at startup and on every
   *  reconnect (ephemeral keys are short-lived, so we always re-mint). Throws with
   *  the server's error text so a token/model/quota failure is visible in the log. */
  private async mintRealtimeToken(): Promise<{ model: string; value: string; vad: unknown }> {
    this.status("minting Realtime token…")
    const tokRes = await fetch(this.opts.tokenUrl, { method: "POST" })
    const tok = await tokRes.json()
    if (!tokRes.ok) throw new Error(tok.error || "realtime-token failed")
    return tok as { model: string; value: string; vad: unknown }
  }

  /** Open (or re-open) the browser-owned OpenAI Realtime WS and wire its lifecycle.
   *  An unexpected close routes to handleRealtimeDisconnect (reconnect). */
  private openRealtimeWs(model: string, value: string) {
    // Fresh session → drop any in-flight response / turn / tool / output state so a
    // stale flag from the dead socket can't wedge the new one.
    this.responseActive = false
    this.responseHasFunctionCall = false
    this.pendingCalls.clear()
    this.resetOutBuffer()

    this.status("connecting Realtime…")
    const url = `${OPENAI_WS_BASE}?model=${encodeURIComponent(model)}`
    const ws = new WebSocket(url, ["realtime", "openai-insecure-api-key." + value])
    this.oaWs = ws

    ws.onopen = () => {
      this.oaReconnectAttempts = 0 // healthy connection — refresh the retry budget
      this.log("✅ [OpenAI] Realtime WS open")
      this.status("LIVE — speak to Ava")
      const queued = this.pendingContext
      this.pendingContext = []
      for (const c of queued) this.sendContext(c.text, c.respond)
      this.maybeGreet()
    }
    ws.onerror = () => this.log("❌ [OpenAI] Realtime WS error")
    ws.onclose = (e) => {
      this.log(`[OpenAI] Realtime WS closed (${e.code}${e.reason ? " " + e.reason : ""})`)
      if (this.oaWs === ws) this.oaWs = null // only the live socket triggers reconnect
      void this.handleRealtimeDisconnect()
    }
    ws.onmessage = (ev) => this.handleRealtimeEvent(ev.data as string)
  }

  /** Revive the brain after an UNEXPECTED OpenAI WS close. A deliberate teardown
   *  (stop()) sets stopping, so we never fight it. The reconnect spins up a brand
   *  new ephemeral session: the L1 persona/dossier are re-baked into the new token,
   *  but in-session conversation history is lost — recovery beats permanent silence.
   *  Bounded retries with a short backoff so a hard failure (bad key, quota) stops
   *  cleanly and surfaces a status instead of looping. */
  private async handleRealtimeDisconnect() {
    if (this.stopping || !this.running) return
    if (this.oaWs) return // a newer socket already took over
    if (this.oaReconnectAttempts >= 3) {
      this.log(`⚠️ [OpenAI] gave up reconnecting after ${this.oaReconnectAttempts} attempts`)
      this.status("voice brain disconnected — reload to retry")
      return
    }
    this.oaReconnectAttempts += 1
    this.log(`↻ [OpenAI] reconnecting (attempt ${this.oaReconnectAttempts})…`)
    this.status("reconnecting Realtime…")
    try {
      const tok = await this.mintRealtimeToken()
      if (this.superseded()) return
      this.openRealtimeWs(tok.model, tok.value)
    } catch (err) {
      this.log(`❌ [OpenAI] reconnect failed: ${(err as Error).message}`)
      setTimeout(() => {
        if (!this.superseded()) void this.handleRealtimeDisconnect()
      }, 2000)
    }
  }

  private handleRealtimeEvent(raw: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const type = msg.type as string

    switch (type) {
      case "input_audio_buffer.speech_started": {
        // Barge-in: the guest started talking over Ava. Stop her on all three
        // fronts — (1) interrupt the avatar (clears HeyGen's queued audio), (2)
        // cancel the in-flight OpenAI response so it stops generating, (3) drop our
        // own pending PCM. Without (2) the response kept streaming and Ava resumed.
        // Only interrupt the avatar when it is ACTUALLY speaking. A phantom VAD
        // turn (server_vad firing on echo/noise with no real speech) would
        // otherwise call interrupt() every time, clearing HeyGen's audio queue for
        // nothing and risking a wedged renderer. avatarSpeaking is the avatar-side
        // analog of the responseActive guard used for response.cancel below.
        if (this.avatarReady && this.avatarSpeaking) {
          try {
            this.avatar?.interrupt()
          } catch {}
          this.avatarSpeaking = false
          this.clearSpeakWatchdog()
        }
        // Don't cancel a response that's executing a tool call — that would drop
        // the action (e.g. view_unit) the guest just asked for. Only cancel
        // speech responses.
        if (
          this.responseActive &&
          !this.responseHasFunctionCall &&
          this.oaWs &&
          this.oaWs.readyState === WebSocket.OPEN
        ) {
          this.oaWs.send(JSON.stringify({ type: "response.cancel" }))
          this.responseActive = false
        }
        this.resetOutBuffer()
        break
      }
      case "input_audio_buffer.speech_stopped": {
        this.turnCounter += 1
        this.cur = {
          turn: this.turnCounter,
          t0: performance.now(),
          t1: null,
          t2: null,
          t3: null,
          realtimeMs: null,
          bridgeMs: null,
          heygenMs: null,
          e2eMs: null,
        }
        this.avaTranscript = ""
        this.log(`🎤 turn ${this.turnCounter}: speech_stopped (t0)`)
        break
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const b64 = msg.delta as string
        if (!b64) break
        this.responseActive = true // a response is producing audio (barge-in can cancel it)
        if (this.cur && this.cur.t1 == null) {
          this.cur.t1 = performance.now()
          this.log(`🔊 t1 first Realtime audio (+${(this.cur.t1 - this.cur.t0).toFixed(0)}ms)`)
        }
        this.enqueueOut(atob(b64))
        break
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const d = msg.delta as string
        if (d) this.avaTranscript += d
        break
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (msg.transcript) this.cb.onTranscript?.("user", msg.transcript as string)
        break
      }
      // ---- function calling (wired in Phase A.2) ----
      case "response.output_item.added": {
        const item = msg.item as { type?: string; name?: string; call_id?: string } | undefined
        if (item?.type === "function_call" && item.call_id && item.name) {
          this.responseHasFunctionCall = true // protect this response from barge-in cancel
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
      case "response.created": {
        this.responseActive = true // a response started (may be cancelled by barge-in)
        this.responseHasFunctionCall = false // until an output item says otherwise
        break
      }
      case "response.output_audio.done":
      case "response.audio.done":
      case "response.done": {
        if (type === "response.done") {
          this.responseActive = false
          this.responseHasFunctionCall = false
        }
        this.flushOut(true)
        if (type === "response.done") {
          const hadSpoken = !!this.avaTranscript
          if (hadSpoken) {
            this.cb.onTranscript?.("ava", this.avaTranscript)
            this.avaTranscript = ""
          }
          // End-of-experience: the close was requested by end_experience. The
          // function-call response that triggered it carries NO audio, so we wait
          // for the first SPOKEN response to finish (Ava's farewell), let the
          // buffered HeyGen audio play out, then signal the UI to tear down.
          if (this.closeRequested && hadSpoken) {
            this.closeRequested = false
            if (this.closeFallbackTimer) {
              clearTimeout(this.closeFallbackTimer)
              this.closeFallbackTimer = null
            }
            setTimeout(() => this.cb.onFarewellSpoken?.(), FAREWELL_TAIL_MS)
          }
        }
        break
      }
      case "error": {
        this.log(`❌ [OpenAI] Realtime error: ${JSON.stringify(msg.error ?? msg)}`)
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
    } catch {
      /* leave empty */
    }

    let output = "ok"
    try {
      output = this.toolHandler ? await this.toolHandler(name, args) : `No handler for ${name}`
      this.log(`🛠️ ${name}(${rawArgs}) → ${output}`)
    } catch (err) {
      output = `error: ${(err as Error).message}`
      this.log(`❌ tool ${name} failed: ${(err as Error).message}`)
    }

    if (this.oaWs && this.oaWs.readyState === WebSocket.OPEN) {
      this.oaWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output },
        }),
      )
      this.oaWs.send(JSON.stringify({ type: "response.create" }))
    }
  }

  // ---- outgoing PCM coalescing → HeyGen ---------------------------------

  private enqueueOut(binaryPcm: string) {
    this.pcmBytes += binaryPcm
    if (this.flushTimer) return
    const delay = this.firstFlushDone ? 100 : 0 // first chunk ASAP (keeps t2 low)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushOut(false)
    }, delay)
  }

  private flushOut(final: boolean) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.pcmBytes) return
    const bytes = this.pcmBytes
    this.pcmBytes = ""
    this.firstFlushDone = true
    try {
      // HeyGen repeatAudio() wants BASE64 PCM16@24k — encode the batched bytes.
      // Only count/arm when an avatar actually received it.
      if (this.avatar) {
        this.avatar.repeatAudio(btoa(bytes))
        this.repeatAudioCount += 1
        this.armSpeakWatchdog() // expect an AVATAR_SPEAK_STARTED back, or recover
        if (this.cur && this.cur.t2 == null) {
          this.cur.t2 = performance.now()
          this.log(
            `📤 t2 first chunk → HeyGen (+${(this.cur.t2 - (this.cur.t1 ?? this.cur.t0)).toFixed(0)}ms after t1)`,
          )
        }
      }
    } catch (err) {
      this.log(`❌ [HeyGen] repeatAudio failed: ${(err as Error).message}`)
    }
    if (final) this.firstFlushDone = false
  }

  private resetOutBuffer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pcmBytes = ""
    this.firstFlushDone = false
    this.clearSpeakWatchdog() // the pending audio is gone — nothing to wait on
  }

  // ---- avatar speak watchdog --------------------------------------------

  /** Arm the stall watchdog after pushing audio to HeyGen. No-op if the avatar is
   *  already confirmed speaking (mid-utterance flushes don't re-arm) or a watchdog
   *  is already pending. Cleared by AVATAR_SPEAK_STARTED (the healthy path). */
  private armSpeakWatchdog() {
    if (this.avatarSpeaking || this.speakWatchdogTimer) return
    if (!this.avatarReady) return
    this.speakWatchdogTimer = setTimeout(() => {
      this.speakWatchdogTimer = null
      void this.onSpeakStalled()
    }, SPEAK_WATCHDOG_MS)
  }

  private clearSpeakWatchdog() {
    if (this.speakWatchdogTimer) {
      clearTimeout(this.speakWatchdogTimer)
      this.speakWatchdogTimer = null
    }
  }

  /** Fired when we pushed audio but no AVATAR_SPEAK_STARTED came back in time —
   *  HeyGen is silently wedged while still "connected". Force the avatar through
   *  the normal reconnect path (re-mint + re-attach); the OpenAI brain keeps
   *  running, so the next turn speaks. The in-flight utterance is lost — recovery
   *  beats permanent silence. Skipped if we're already tearing down/reconnecting. */
  private async onSpeakStalled() {
    if (this.stopping || !this.running) return
    if (!this.avatarReady || !this.avatar) return
    this.log(
      `⚠️ [HeyGen] avatar stalled — pushed ${this.repeatAudioCount} chunk(s) but ${this.speakStartedCount} speak_started; forcing reconnect`,
    )
    this.status("avatar stalled — reconnecting…")
    this.avatarSpeaking = false
    await this.handleAvatarDisconnect(SessionDisconnectReason.UNKNOWN_REASON)
  }

  private finalizeTurn() {
    const m = this.cur
    if (!m || m.t3 == null) return
    m.realtimeMs = m.t1 != null ? m.t1 - m.t0 : null
    m.bridgeMs = m.t1 != null && m.t2 != null ? m.t2 - m.t1 : null
    m.heygenMs = m.t2 != null ? m.t3 - m.t2 : null
    m.e2eMs = m.t3 - m.t0
    this.log(`✅ turn ${m.turn} t0→t3 = ${m.e2eMs.toFixed(0)}ms`)
    this.cb.onMetric?.(m)
  }

  private status(s: string) {
    this.cb.onStatus?.(s)
  }
  private log(s: string) {
    this.cb.onLog?.(s)
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(binary)
}
