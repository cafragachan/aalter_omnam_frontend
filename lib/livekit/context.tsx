"use client"

// Stage 3 of the HeyGen → LiveKit migration, post Strict Mode refactor.
//
// LiveKitAvatarContextProvider is now a thin adapter around
// <LiveKitRoom> from @livekit/components-react. The original Stage 3
// implementation created a `livekit-client` Room manually and managed
// its lifecycle inside a custom useEffect — that works in isolation
// but races under React 19 Strict Mode's double-mount: the first mount
// starts a connect, Strict Mode synchronously tears it down, then the
// second mount creates a second Room with the SAME token/identity,
// and LiveKit Cloud's duplicate-identity kick closes the first Room's
// peer connection mid-`createOffer` → the whole thing collapses
// intermittently (~50% failure in dev). The symptom in the console
// was a mix of "could not establish pc connection" + "could not
// createOffer with closed peer connection" + "skipping incoming
// track after Room disconnected".
//
// <LiveKitRoom> already solves this correctly (Stage 2 proved it
// under the same conditions). Wrapping it lets us piggyback on that
// strict-mode-safe lifecycle and get <RoomAudioRenderer/> for free,
// which fixes the companion bug where the Hedra avatar's audio track
// was subscribed but never attached to an <audio> element (the old
// Stage 3 LiveKitAvatarPlayer only handled video).
//
// Consumer contract is UNCHANGED. useLiveKitAvatarContext still
// returns the same field-for-field shape: sessionRef / isMuted /
// voiceChatState / sessionState / isStreamReady / connectionQuality /
// isUserTalking / isAvatarTalking / messages / subscribeToToolCalls.
// sessionRef.current is now sourced from useRoomContext() instead of
// a hand-managed ref, but the type is the same and consumers must not
// rely on it beyond reading `.current` as a Room.
//
// Structure:
//   LiveKitAvatarContextProvider (outer)
//     └─ <LiveKitRoom token serverUrl audio video=false connect>
//          ├─ <RoomAudioRenderer/>  ← plays all subscribed audio tracks
//          └─ <LiveKitContextBridge>   ← useRoomContext() + event subs
//                └─ <LiveKitAvatarContext.Provider value={...}>
//                     └─ {children}
//
// The outer/inner split is required because useRoomContext() only
// works inside a LiveKitRoom subtree — the bridge cannot live in the
// same component as the <LiveKitRoom> element.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
} from "@livekit/components-react"
import {
  ConnectionQuality as LKConnectionQuality,
  ConnectionState as LKConnectionState,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
} from "livekit-client"

import {
  LiveAvatarSessionMessage,
  MessageSender,
} from "./types"
import {
  subscribeToMessages,
  type DataChannelMessage,
} from "./data-channel"

// ---------------------------------------------------------------------
// Compatibility enums
// ---------------------------------------------------------------------
//
// These reproduce the string values of the matching HeyGen SDK enums so
// that `state === SessionState.CONNECTED`-style comparisons in existing
// consumers (e.g. app/home/page.tsx) keep working when the page is
// copied to /home-v2 and imports from @/lib/livekit instead of
// @heygen/liveavatar-web-sdk.
//
// Source of truth:
//   SessionState     — node_modules/@heygen/liveavatar-web-sdk/lib/LiveAvatarSession/types.d.ts:2
//                      (INACTIVE/CONNECTING/CONNECTED/DISCONNECTING/DISCONNECTED)
//   VoiceChatState   — node_modules/@heygen/liveavatar-web-sdk/lib/VoiceChat/types.d.ts:5
//                      (INACTIVE/STARTING/ACTIVE)
//   ConnectionQuality— node_modules/@heygen/liveavatar-web-sdk/lib/QualityIndicator/types.d.ts:1
//                      (UNKNOWN/GOOD/BAD)

export const SessionState = {
  INACTIVE: "INACTIVE",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  DISCONNECTING: "DISCONNECTING",
  DISCONNECTED: "DISCONNECTED",
} as const
export type SessionState = (typeof SessionState)[keyof typeof SessionState]

export const VoiceChatState = {
  INACTIVE: "INACTIVE",
  STARTING: "STARTING",
  ACTIVE: "ACTIVE",
} as const
export type VoiceChatState = (typeof VoiceChatState)[keyof typeof VoiceChatState]

export const ConnectionQuality = {
  UNKNOWN: "UNKNOWN",
  GOOD: "GOOD",
  BAD: "BAD",
} as const
export type ConnectionQuality =
  (typeof ConnectionQuality)[keyof typeof ConnectionQuality]

// Map livekit-client's ConnectionQuality (lowercase, 5 values) onto
// the legacy HeyGen-shaped enum (uppercase, 3 values).
function mapConnectionQuality(q: LKConnectionQuality): ConnectionQuality {
  switch (q) {
    case LKConnectionQuality.Excellent:
    case LKConnectionQuality.Good:
      return ConnectionQuality.GOOD
    case LKConnectionQuality.Poor:
    case LKConnectionQuality.Lost:
      return ConnectionQuality.BAD
    case LKConnectionQuality.Unknown:
    default:
      return ConnectionQuality.UNKNOWN
  }
}

// Map livekit-client's ConnectionState onto the legacy SessionState.
// Reconnecting maps to CONNECTING so a transient blip doesn't trip a
// DISCONNECTED-driven cleanup in app/home/page.tsx:954.
function mapSessionState(s: LKConnectionState): SessionState {
  switch (s) {
    case LKConnectionState.Connected:
      return SessionState.CONNECTED
    case LKConnectionState.Connecting:
    case LKConnectionState.Reconnecting:
      return SessionState.CONNECTING
    case LKConnectionState.Disconnected:
      return SessionState.DISCONNECTED
    default:
      return SessionState.INACTIVE
  }
}

// ---------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------

const AVATAR_PARTICIPANT_NAME = "hedra-avatar-agent"

type ToolCallPayload = Extract<DataChannelMessage, { type: "tool_call" }>
type ToolCallHandler = (msg: ToolCallPayload) => void

type LiveKitAvatarContextProps = {
  /**
   * Ref whose `.current` points at the active livekit-client Room.
   * Now sourced from useRoomContext() internally — consumers see the
   * same shape as the original Stage 3 hand-managed ref.
   */
  sessionRef: React.RefObject<Room | null>
  isMuted: boolean
  voiceChatState: VoiceChatState
  sessionState: SessionState
  isStreamReady: boolean
  connectionQuality: ConnectionQuality
  isUserTalking: boolean
  isAvatarTalking: boolean
  messages: LiveAvatarSessionMessage[]
  /**
   * Subscribe to tool_call data-channel messages. Returns an unsubscribe
   * function. Tool calls are intentionally kept off the `messages[]`
   * array so the Stage 5 tool bridge can listen without re-rendering
   * the whole provider subtree on every call.
   */
  subscribeToToolCalls: (handler: ToolCallHandler) => () => void
}

const LiveKitAvatarContext = createContext<LiveKitAvatarContextProps | null>(
  null,
)

// ---------------------------------------------------------------------
// Inner bridge — reads the Room from useRoomContext() and publishes
// the LiveKitAvatarContext to downstream consumers. Lives INSIDE
// <LiveKitRoom> so useRoomContext() resolves.
// ---------------------------------------------------------------------

function LiveKitContextBridge({ children }: { children: ReactNode }) {
  const room = useRoomContext()

  // sessionRef.current tracks the Room from useRoomContext() on every
  // render. The ref object itself is stable so consumer useEffect
  // deps on sessionRef don't re-fire.
  const sessionRef = useRef<Room | null>(null)
  sessionRef.current = room

  const [sessionState, setSessionState] = useState<SessionState>(() =>
    mapSessionState(room.state),
  )
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>(
    ConnectionQuality.UNKNOWN,
  )
  const [isStreamReady, setIsStreamReady] = useState<boolean>(false)
  const [isMuted, setIsMuted] = useState(true)
  const [voiceChatState, setVoiceChatState] = useState<VoiceChatState>(
    VoiceChatState.INACTIVE,
  )
  const [isUserTalking, setIsUserTalking] = useState(false)
  const [isAvatarTalking, setIsAvatarTalking] = useState(false)
  const [messages, setMessages] = useState<LiveAvatarSessionMessage[]>([])

  // Tool-call subscribers live in a ref — mutating this must never
  // re-render the provider.
  const toolCallHandlersRef = useRef<Set<ToolCallHandler>>(new Set())
  const subscribeToToolCalls = useCallback((handler: ToolCallHandler) => {
    toolCallHandlersRef.current.add(handler)
    return () => {
      toolCallHandlersRef.current.delete(handler)
    }
  }, [])

  // ------------------------------------------------------------
  // Room event subscriptions + data-channel
  // ------------------------------------------------------------
  //
  // LiveKitRoom owns the Room lifecycle (create, connect, reconnect,
  // disconnect). The bridge only observes. On mount it attaches
  // listeners and snapshots the current state; on unmount it detaches.
  // Strict Mode's double-mount is safe here because LiveKitRoom uses
  // its own useState-stable Room across cycles — the two mounts of
  // the bridge attach and detach listeners on the SAME Room instance,
  // which is idempotent.
  useEffect(() => {
    // Event handlers (closure-capture `room` from the outer scope)
    const handleConnectionStateChanged = (state: LKConnectionState) => {
      const mapped = mapSessionState(state)
      setSessionState(mapped)
      if (mapped === SessionState.CONNECTED) {
        setVoiceChatState(VoiceChatState.ACTIVE)
        // Sync mic state once connected (may race with the initial
        // publish — TrackUnmuted listener catches any later change).
        const local = room.localParticipant
        if (local) setIsMuted(!local.isMicrophoneEnabled)
      } else if (mapped === SessionState.CONNECTING) {
        setVoiceChatState(VoiceChatState.STARTING)
      } else if (mapped === SessionState.DISCONNECTED) {
        setVoiceChatState(VoiceChatState.INACTIVE)
        setIsStreamReady(false)
      }
    }

    const handleDisconnected = () => {
      setSessionState(SessionState.DISCONNECTED)
      setVoiceChatState(VoiceChatState.INACTIVE)
      setIsStreamReady(false)
      setIsUserTalking(false)
      setIsAvatarTalking(false)
    }

    const maybeMarkStreamReady = (participant: RemoteParticipant) => {
      if (participant.name === AVATAR_PARTICIPANT_NAME) {
        setIsStreamReady(true)
      }
    }

    const handleParticipantConnected = (participant: RemoteParticipant) => {
      maybeMarkStreamReady(participant)
    }

    const handleTrackSubscribed = (
      _track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      maybeMarkStreamReady(participant)
    }

    const handleActiveSpeakersChanged = (speakers: Participant[]) => {
      const localIdentity = room.localParticipant?.identity
      let userTalking = false
      let avatarTalking = false
      for (const speaker of speakers) {
        if (localIdentity && speaker.identity === localIdentity) {
          userTalking = true
        }
        if (speaker.name === AVATAR_PARTICIPANT_NAME) {
          avatarTalking = true
        }
      }
      setIsUserTalking(userTalking)
      setIsAvatarTalking(avatarTalking)
    }

    const handleConnectionQualityChanged = (
      quality: LKConnectionQuality,
      participant: Participant,
    ) => {
      // Only track the local participant's connection quality —
      // matches legacy semantics.
      if (
        room.localParticipant &&
        participant.identity === room.localParticipant.identity
      ) {
        setConnectionQuality(mapConnectionQuality(quality))
      }
    }

    // Stage 6 Phase B Fix 1: filter to only the LOCAL participant's mic
    // track. RoomEvent.TrackMuted fires for ALL tracks (including the
    // Hedra avatar's audio/video tracks), which was causing isMuted to
    // flip to true during speech interruption when the avatar's track
    // got muted.
    const handleLocalTrackMuted = (
      publication: TrackPublication,
      participant: Participant,
    ) => {
      if (
        room.localParticipant &&
        participant.identity === room.localParticipant.identity &&
        publication.source === Track.Source.Microphone
      ) {
        setIsMuted(true)
      }
    }
    const handleLocalTrackUnmuted = (
      publication: TrackPublication,
      participant: Participant,
    ) => {
      if (
        room.localParticipant &&
        participant.identity === room.localParticipant.identity &&
        publication.source === Track.Source.Microphone
      ) {
        setIsMuted(false)
      }
    }

    room.on(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged)
    room.on(RoomEvent.Disconnected, handleDisconnected)
    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected)
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged)
    room.on(RoomEvent.ConnectionQualityChanged, handleConnectionQualityChanged)
    room.on(RoomEvent.TrackMuted, handleLocalTrackMuted)
    room.on(RoomEvent.TrackUnmuted, handleLocalTrackUnmuted)

    // Data-channel subscription (transcripts → messages[]; tool_call
    // → ref-dispatched handler list; everything else ignored).
    const unsubscribeDataChannel = subscribeToMessages(room, (msg) => {
      if (msg.type === "transcript") {
        const sender =
          msg.role === "user" ? MessageSender.USER : MessageSender.AVATAR
        setMessages((prev) => [
          ...prev,
          { sender, message: msg.text, timestamp: Date.now() },
        ])
        return
      }
      if (msg.type === "tool_call") {
        // Snapshot the handler list before invoking so handlers that
        // unsubscribe themselves mid-iteration don't skip siblings.
        const handlers = Array.from(toolCallHandlersRef.current)
        for (const handler of handlers) {
          try {
            handler(msg)
          } catch (err) {
            console.error("[livekit] tool_call handler threw:", err)
          }
        }
        return
      }
      // state_snapshot / narration_nudge / ui_event / user_message /
      // speak / interrupt are outbound only — stray echoes are ignored.
    })

    // Initial state sync — the bridge may mount after the Room has
    // already fired some events (LiveKitRoom starts connecting before
    // children render). Snapshot whatever is already true.
    setSessionState(mapSessionState(room.state))
    if (room.state === LKConnectionState.Connected) {
      setVoiceChatState(VoiceChatState.ACTIVE)
      const local = room.localParticipant
      if (local) setIsMuted(!local.isMicrophoneEnabled)
    } else if (room.state === LKConnectionState.Connecting) {
      setVoiceChatState(VoiceChatState.STARTING)
    }
    for (const participant of room.remoteParticipants.values()) {
      maybeMarkStreamReady(participant)
    }

    return () => {
      room.off(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged)
      room.off(RoomEvent.Disconnected, handleDisconnected)
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected)
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged)
      room.off(
        RoomEvent.ConnectionQualityChanged,
        handleConnectionQualityChanged,
      )
      room.off(RoomEvent.TrackMuted, handleLocalTrackMuted)
      room.off(RoomEvent.TrackUnmuted, handleLocalTrackUnmuted)
      unsubscribeDataChannel()
    }
  }, [room])

  const value = useMemo<LiveKitAvatarContextProps>(
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
      subscribeToToolCalls,
    }),
    [
      connectionQuality,
      isAvatarTalking,
      isMuted,
      isStreamReady,
      isUserTalking,
      messages,
      sessionState,
      subscribeToToolCalls,
      voiceChatState,
    ],
  )

  return (
    <LiveKitAvatarContext.Provider value={value}>
      {children}
    </LiveKitAvatarContext.Provider>
  )
}

// ---------------------------------------------------------------------
// Outer provider — owns token/serverUrl props and renders
// <LiveKitRoom> + <RoomAudioRenderer/> + the bridge.
// ---------------------------------------------------------------------

export function LiveKitAvatarContextProvider({
  children,
  token,
  serverUrl,
  roomName,
}: {
  children: ReactNode
  token: string
  /** LiveKit server URL. If omitted, reads NEXT_PUBLIC_LIVEKIT_URL. */
  serverUrl?: string
  /**
   * Informational only — LiveKitRoom extracts the room from the token.
   * Kept in the prop surface so Stage 5's page wiring can pass it
   * through without code changes.
   */
  roomName?: string
}) {
  // Track roomName purely to silence the unused-prop lint and keep it
  // accessible for future logging without triggering re-renders.
  const roomNameRef = useRef(roomName)
  roomNameRef.current = roomName

  const url = serverUrl ?? process.env.NEXT_PUBLIC_LIVEKIT_URL

  if (!url) {
    console.error(
      "[livekit] no server URL provided (pass serverUrl prop or set NEXT_PUBLIC_LIVEKIT_URL)",
    )
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={url}
      connect={true}
      audio={true}
      video={false}
    >
      <RoomAudioRenderer />
      <LiveKitContextBridge>{children}</LiveKitContextBridge>
    </LiveKitRoom>
  )
}

export function useLiveKitAvatarContext() {
  const context = useContext(LiveKitAvatarContext)
  if (!context) {
    throw new Error(
      "useLiveKitAvatarContext must be used within a LiveKitAvatarContextProvider",
    )
  }
  return context
}
