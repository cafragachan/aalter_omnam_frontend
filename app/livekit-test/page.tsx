"use client";

// THROWAWAY TEST PAGE — Stage 1 of HeyGen → LiveKit migration.
// Intentionally isolated from all Omnam UI, providers, and styling.
// Will be deleted at Stage 7. Do NOT import from lib/liveavatar/,
// lib/orchestrator/, components/panels/, or any other Omnam folder.

import { useCallback, useState } from "react";
import {
  LiveKitRoom,
  VideoTrack,
  useRemoteParticipants,
  useTracks,
  RoomAudioRenderer,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";

const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL!;
const AVATAR_PARTICIPANT_NAME = "hedra-avatar-agent";

function AvatarVideo() {
  const remoteParticipants = useRemoteParticipants();
  const tracks = useTracks([Track.Source.Camera], {
    onlySubscribed: true,
  });

  const avatarTrack = tracks.find(
    (t) => t.participant.name === AVATAR_PARTICIPANT_NAME
  );

  if (!avatarTrack) {
    return (
      <div
        style={{
          aspectRatio: "1 / 1",
          width: 758,
          maxWidth: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#222",
          borderRadius: 12,
          color: "#888",
        }}
      >
        {remoteParticipants.length === 0
          ? "Waiting for avatar agent to join..."
          : "Connecting avatar..."}
      </div>
    );
  }

  return (
    <div
      style={{
        aspectRatio: "1 / 1",
        width: 512,
        maxWidth: "100%",
        overflow: "hidden",
        borderRadius: 12,
      }}
    >
      <VideoTrack
        trackRef={avatarTrack}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
        }}
      />
    </div>
  );
}

export default function LiveKitTestPage() {
  const [token, setToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const roomName = `avatar-room-${Date.now()}`;
      const participantName = `user-${Math.random().toString(36).slice(2, 8)}`;

      const res = await fetch("/api/livekit-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, participantName }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setToken(data.token);
      setConnected(true);
    } catch (err) {
      console.error("Failed to get token:", err);
      alert("Failed to connect. Check console for details.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setToken(null);
    setConnected(false);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.5rem",
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 24, margin: 0 }}>LiveKit Test Harness</h1>
      <p style={{ color: "#888", margin: 0, fontSize: 14 }}>
        Stage 1 smoke check — isolated from Omnam UI
      </p>

      {!connected || !token ? (
        <button
          onClick={connect}
          disabled={connecting}
          style={{
            padding: "12px 32px",
            fontSize: 18,
            borderRadius: 8,
            border: "none",
            background: "#0070f3",
            color: "#fff",
            cursor: connecting ? "wait" : "pointer",
          }}
        >
          {connecting ? "Connecting..." : "Connect"}
        </button>
      ) : (
        <LiveKitRoom
          serverUrl={LIVEKIT_URL}
          token={token}
          connect={true}
          audio={true}
          video={false}
          onDisconnected={disconnect}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <AvatarVideo />
          <RoomAudioRenderer />
          <button
            onClick={disconnect}
            style={{
              padding: "8px 24px",
              fontSize: 14,
              borderRadius: 6,
              border: "1px solid #555",
              background: "transparent",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Disconnect
          </button>
        </LiveKitRoom>
      )}
    </div>
  );
}
