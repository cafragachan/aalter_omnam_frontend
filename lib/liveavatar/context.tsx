"use client"

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
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
  messages: LiveAvatarSessionMessage[]
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

    const handleUserStart = () => setIsUserTalking(true)
    const handleUserEnd = () => setIsUserTalking(false)
    const handleAvatarStart = () => setIsAvatarTalking(true)
    const handleAvatarEnd = () => setIsAvatarTalking(false)

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
      messages,
    }),
    [connectionQuality, isAvatarTalking, isMuted, isStreamReady, isUserTalking, messages, sessionState, voiceChatState],
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

