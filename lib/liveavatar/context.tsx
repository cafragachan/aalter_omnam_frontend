"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import {
  AgentEventsEnum,
  ConnectionQuality,
  LiveAvatarSession,
  SessionEvent,
  SessionState,
  VoiceChatEvent,
  VoiceChatState,
} from "@heygen/liveavatar-web-sdk"
import { LiveAvatarSessionMessage, MessageSender } from "./types"

type LiveAvatarContextProps = {
  sessionRef: React.RefObject<LiveAvatarSession | null>
  isMuted: boolean
  voiceChatState: VoiceChatState
  sessionState: SessionState
  isStreamReady: boolean
  connectionQuality: ConnectionQuality
  isUserTalking: boolean
  isAvatarTalking: boolean
  /** performance.now() timestamp for the latest HeyGen USER_SPEAK_ENDED event. */
  lastUserSpeakEndedAtRef: RefObject<number | null>
  // ---- Wall-clock (Date.now ms) refs powering the per-session latency log file ----
  /** Date.now ms at HeyGen USER_SPEAK_ENDED. Cleared per turn after consumption. */
  lastUserSpeakEndedAtMsRef: RefObject<number | null>
  /** Date.now ms at HeyGen USER_TRANSCRIPTION (final transcript landed). */
  lastUserTranscriptionAtMsRef: RefObject<number | null>
  /** Date.now ms at HeyGen AVATAR_SPEAK_STARTED (first audio frame). */
  lastAvatarSpeakStartedAtMsRef: RefObject<number | null>
  /** Date.now ms at HeyGen AVATAR_SPEAK_ENDED (last audio frame). */
  lastAvatarSpeakEndedAtMsRef: RefObject<number | null>
  /** UUID v4 minted once per provider mount. Names the per-session log file. */
  sessionIdRef: RefObject<string>
  messages: LiveAvatarSessionMessage[]
  /**
   * Manually append a message to the transcript. Used by chat mode to inject
   * user-typed input and avatar responses that bypass HeyGen's STT/TTS
   * (and therefore never fire USER_TRANSCRIPTION / AVATAR_TRANSCRIPTION).
   * In voice mode this should not be called — HeyGen's events populate
   * `messages` on their own.
   */
  appendMessage: (sender: MessageSender, text: string) => void
  /**
   * Drop incoming HeyGen USER_TRANSCRIPTION events instead of appending them.
   * Chat mode flips this on to prevent ghost text — `voiceChat.mute()` alone
   * doesn't stop the server-side STT pipeline from emitting transcripts.
   */
  setSuppressUserTranscription: (suppress: boolean) => void
}

const LiveAvatarContext = createContext<LiveAvatarContextProps | null>(null)

const DEFAULT_API_URL = "https://api.liveavatar.com"

export function LiveAvatarContextProvider({
  children,
  sessionAccessToken,
  initialMessages,
}: {
  children: ReactNode
  sessionAccessToken: string
  /**
   * Phase 5 — Conversation persistence. When provided, seeds the in-memory
   * `messages` state with prior turns hydrated from Firebase before HeyGen
   * starts streaming. The array is read once on mount; subsequent changes
   * are ignored so live transcriptions are never clobbered.
   */
  initialMessages?: LiveAvatarSessionMessage[]
}) {
  const sessionRef = useRef<LiveAvatarSession | null>(null)

  if (!sessionRef.current) {
    const apiUrl = process.env.NEXT_PUBLIC_HEYGEN_API_URL || DEFAULT_API_URL
    sessionRef.current = new LiveAvatarSession(sessionAccessToken, {
      voiceChat: true,
      apiUrl,
    })
  }

  const [sessionState, setSessionState] = useState<SessionState>(
    sessionRef.current?.state ?? SessionState.INACTIVE,
  )
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>(
    sessionRef.current?.connectionQuality ?? ConnectionQuality.UNKNOWN,
  )
  const [isStreamReady, setIsStreamReady] = useState<boolean>(false)
  const [isMuted, setIsMuted] = useState(true)
  const [voiceChatState, setVoiceChatState] = useState<VoiceChatState>(
    sessionRef.current?.voiceChat.state ?? VoiceChatState.INACTIVE,
  )
  const lastUserSpeakEndedAtRef = useRef<number | null>(null)
  // Wall-clock companions for the latency-log pipeline. See context type for
  // semantics — these all use `Date.now()` so they can be diffed against
  // server-side `requestReceived`/`responseSent` timestamps without timezone
  // or perf-origin gymnastics.
  const lastUserSpeakEndedAtMsRef = useRef<number | null>(null)
  const lastUserTranscriptionAtMsRef = useRef<number | null>(null)
  const lastAvatarSpeakStartedAtMsRef = useRef<number | null>(null)
  const lastAvatarSpeakEndedAtMsRef = useRef<number | null>(null)
  // Lazy-init so SSR doesn't crash on missing `crypto`. Stable across renders
  // because `useRef` only runs the initializer on first render.
  const sessionIdRef = useRef<string>(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
  )
  const [isUserTalking, setIsUserTalking] = useState(false)
  const [isAvatarTalking, setIsAvatarTalking] = useState(false)
  const [messages, setMessages] = useState<LiveAvatarSessionMessage[]>(
    () => (initialMessages && initialMessages.length > 0 ? [...initialMessages] : []),
  )

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return

    const handleStateChange = (state: SessionState) => {
      setSessionState(state)
      if (state === SessionState.DISCONNECTED) {
        session.removeAllListeners()
        session.voiceChat.removeAllListeners()
        setIsStreamReady(false)
      }
    }

    session.on(SessionEvent.SESSION_STATE_CHANGED, handleStateChange)
    session.on(SessionEvent.SESSION_STREAM_READY, () => setIsStreamReady(true))
    session.on(SessionEvent.SESSION_CONNECTION_QUALITY_CHANGED, setConnectionQuality)

    return () => {
      session.removeListener(SessionEvent.SESSION_STATE_CHANGED, handleStateChange)
      session.removeAllListeners(SessionEvent.SESSION_STREAM_READY)
      session.removeAllListeners(SessionEvent.SESSION_CONNECTION_QUALITY_CHANGED)
    }
  }, [])

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return

    const handleMuted = () => setIsMuted(true)
    const handleUnmuted = () => setIsMuted(false)

    session.voiceChat.on(VoiceChatEvent.MUTED, handleMuted)
    session.voiceChat.on(VoiceChatEvent.UNMUTED, handleUnmuted)
    session.voiceChat.on(VoiceChatEvent.STATE_CHANGED, setVoiceChatState)

    return () => {
      session.voiceChat.removeListener(VoiceChatEvent.MUTED, handleMuted)
      session.voiceChat.removeListener(VoiceChatEvent.UNMUTED, handleUnmuted)
      session.voiceChat.removeAllListeners(VoiceChatEvent.STATE_CHANGED)
    }
  }, [])

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return

    const handleUserStart = () => {
      // Latency log: a new utterance is starting, so any USER_SPEAK_ENDED
      // value still in the refs is from a previous utterance — drop it. We
      // observed HeyGen sometimes fires USER_SPEAK_ENDED 1-2s AFTER the
      // matching USER_TRANSCRIPTION, which would otherwise leak the prior
      // turn's speak-end timestamp into the next turn's STT calculation
      // when the next utterance has no USER_SPEAK_ENDED of its own.
      // Clearing on START is the right boundary: the user must start a new
      // utterance before they can end it.
      lastUserSpeakEndedAtRef.current = null
      lastUserSpeakEndedAtMsRef.current = null
      setIsUserTalking(true)
    }
    const handleUserEnd = () => {
      lastUserSpeakEndedAtRef.current = performance.now()
      lastUserSpeakEndedAtMsRef.current = Date.now()
      setIsUserTalking(false)
    }
    const handleAvatarStart = () => {
      lastAvatarSpeakStartedAtMsRef.current = Date.now()
      setIsAvatarTalking(true)
    }
    const handleAvatarEnd = () => {
      lastAvatarSpeakEndedAtMsRef.current = Date.now()
      setIsAvatarTalking(false)
    }

    session.on(AgentEventsEnum.USER_SPEAK_STARTED, handleUserStart)
    session.on(AgentEventsEnum.USER_SPEAK_ENDED, handleUserEnd)
    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, handleAvatarStart)
    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, handleAvatarEnd)

    return () => {
      session.removeListener(AgentEventsEnum.USER_SPEAK_STARTED, handleUserStart)
      session.removeListener(AgentEventsEnum.USER_SPEAK_ENDED, handleUserEnd)
      session.removeListener(AgentEventsEnum.AVATAR_SPEAK_STARTED, handleAvatarStart)
      session.removeListener(AgentEventsEnum.AVATAR_SPEAK_ENDED, handleAvatarEnd)
    }
  }, [])

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return

    const handleUserTranscription = ({ text }: { text: string }) => {
      if (suppressUserTranscriptionRef.current) {
        console.log("[USER_TX][suppressed]", JSON.stringify(text))
        return
      }
      lastUserTranscriptionAtMsRef.current = Date.now()
      console.log("[USER_TX]", JSON.stringify(text))
      setMessages((prev) => [
        ...prev,
        { sender: MessageSender.USER, message: text, timestamp: Date.now() },
      ])
    }

    const handleAvatarTranscription = ({ text }: { text: string }) => {
      console.log("[AVATAR_TX]", JSON.stringify(text))
      setMessages((prev) => [
        ...prev,
        { sender: MessageSender.AVATAR, message: text, timestamp: Date.now() },
      ])
    }

    session.on(AgentEventsEnum.USER_TRANSCRIPTION, handleUserTranscription)
    session.on(AgentEventsEnum.AVATAR_TRANSCRIPTION, handleAvatarTranscription)

    return () => {
      session.removeListener(AgentEventsEnum.USER_TRANSCRIPTION, handleUserTranscription)
      session.removeListener(AgentEventsEnum.AVATAR_TRANSCRIPTION, handleAvatarTranscription)
    }
  }, [])

  const appendMessage = useCallback((sender: MessageSender, text: string) => {
    setMessages((prev) => [
      ...prev,
      { sender, message: text, timestamp: Date.now() },
    ])
  }, [])

  const suppressUserTranscriptionRef = useRef<boolean>(false)
  const setSuppressUserTranscription = useCallback((suppress: boolean) => {
    suppressUserTranscriptionRef.current = suppress
  }, [])

  const value = useMemo(
    () => ({
      sessionRef,
      isMuted,
      voiceChatState,
      sessionState,
      isStreamReady,
      connectionQuality,
      isUserTalking,
      isAvatarTalking,
      lastUserSpeakEndedAtRef,
      lastUserSpeakEndedAtMsRef,
      lastUserTranscriptionAtMsRef,
      lastAvatarSpeakStartedAtMsRef,
      lastAvatarSpeakEndedAtMsRef,
      sessionIdRef,
      messages,
      appendMessage,
      setSuppressUserTranscription,
    }),
    [appendMessage, connectionQuality, isAvatarTalking, isMuted, isStreamReady, isUserTalking, lastUserSpeakEndedAtRef, lastUserSpeakEndedAtMsRef, lastUserTranscriptionAtMsRef, lastAvatarSpeakStartedAtMsRef, lastAvatarSpeakEndedAtMsRef, sessionIdRef, messages, sessionState, setSuppressUserTranscription, voiceChatState],
  )

  return <LiveAvatarContext.Provider value={value}>{children}</LiveAvatarContext.Provider>
}

export function useLiveAvatarContext() {
  const context = useContext(LiveAvatarContext)
  if (!context) {
    throw new Error("useLiveAvatarContext must be used within a LiveAvatarContextProvider")
  }
  return context
}

