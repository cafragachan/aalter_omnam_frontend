"use client"

// Stage 3 of the HeyGen → LiveKit migration.
//
// Mirrors the return shape of lib/liveavatar/useSession.ts exactly:
//   { sessionState, isStreamReady, connectionQuality, startSession,
//     stopSession, keepAlive, attachElement }
//
// Connection lifecycle is actually owned by LiveKitAvatarContextProvider
// (it connects on mount, disconnects on unmount) — so startSession and
// stopSession are thin wrappers that let legacy consumers call them
// without noticing. startSession is a no-op when the provider already
// connected; stopSession forces an immediate disconnect.

import { useCallback } from "react"
import { Track } from "livekit-client"
import { useLiveKitAvatarContext } from "./context"

const AVATAR_PARTICIPANT_NAME = "hedra-avatar-agent"

export const useSession = () => {
  const { sessionRef, sessionState, isStreamReady, connectionQuality } =
    useLiveKitAvatarContext()

  const startSession = useCallback(async () => {
    // The provider connects automatically on mount. If legacy consumers
    // call startSession after the fact, this is a no-op — returning a
    // resolved promise preserves the legacy signature.
    return sessionRef.current
  }, [sessionRef])

  const stopSession = useCallback(async () => {
    const room = sessionRef.current
    if (!room) return
    await room.disconnect()
  }, [sessionRef])

  const keepAlive = useCallback(async () => {
    // LiveKit handles its own ping/pong — no-op.
    return undefined
  }, [])

  const attachElement = useCallback(
    (element: HTMLMediaElement) => {
      const room = sessionRef.current
      if (!room) return

      const tryAttach = () => {
        for (const participant of room.remoteParticipants.values()) {
          if (participant.name !== AVATAR_PARTICIPANT_NAME) continue
          for (const publication of participant.videoTrackPublications.values()) {
            const track = publication.track
            if (track && publication.source === Track.Source.Camera) {
              track.attach(element)
              return true
            }
          }
        }
        return false
      }

      if (tryAttach()) return

      // Not ready yet — wait for the next track to be subscribed and
      // retry. Uses a one-shot listener that removes itself on success.
      const handleTrackSubscribed = () => {
        if (tryAttach()) {
          room.off("trackSubscribed", handleTrackSubscribed)
        }
      }
      room.on("trackSubscribed", handleTrackSubscribed)
    },
    [sessionRef],
  )

  return {
    sessionState,
    isStreamReady,
    connectionQuality,
    startSession,
    stopSession,
    keepAlive,
    attachElement,
  }
}
