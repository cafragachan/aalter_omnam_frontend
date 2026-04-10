"use client";

// THROWAWAY TEST PAGE — Stage 1 of HeyGen → LiveKit migration.
// Intentionally isolated from all Omnam UI, providers, and styling.
// Will be deleted at Stage 7. Do NOT import from lib/liveavatar/,
// lib/orchestrator/, components/panels/, or any other Omnam folder.

import { useCallback, useEffect, useState } from "react";
import {
  LiveKitRoom,
  VideoTrack,
  useRemoteParticipants,
  useTracks,
  useRoomContext,
  RoomAudioRenderer,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";

import {
  publishMessage,
  subscribeToMessages,
  type DataChannelMessage,
} from "@/lib/livekit/data-channel";

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

// Stage 2 spike: subscribes to data-channel messages from the agent and
// exposes three buttons that publish state_snapshot / narration_nudge /
// user_message events back to the agent. Lives inside <LiveKitRoom> so it
// can grab the Room from useRoomContext().
function DataChannelTester() {
  const room = useRoomContext();
  const [received, setReceived] = useState<
    { ts: number; from: string; msg: DataChannelMessage }[]
  >([]);

  useEffect(() => {
    if (!room) return;
    const unsubscribe = subscribeToMessages(room, (msg, participant) => {
      console.log("[livekit-test] data ←", msg);
      setReceived((prev) =>
        [
          { ts: Date.now(), from: participant?.identity ?? "?", msg },
          ...prev,
        ].slice(0, 20),
      );
    });
    return unsubscribe;
  }, [room]);

  const send = useCallback(
    (msg: DataChannelMessage) => {
      if (!room) return;
      console.log("[livekit-test] data →", msg);
      publishMessage(room, msg).catch((err) =>
        console.error("[livekit-test] publish failed:", err),
      );
    },
    [room],
  );

  const injectSnapshot = useCallback(() => {
    send({
      type: "state_snapshot",
      payload: {
        firstName: "Sarah",
        partySize: 4,
        selectedHotel: "EDITION Lake Como",
        currentRoom: "Loft Suite",
        visitedAmenities: ["spa", "restaurant"],
      },
    });
  }, [send]);

  const injectNudge = useCallback(() => {
    send({
      type: "narration_nudge",
      intent: "TEST_GREETING",
      guidance:
        "Greet the user warmly by name in one short sentence and mention how excited you are about the hotel they picked.",
      priority: "interrupt",
    });
  }, [send]);

  const sendFakeUserMessage = useCallback(() => {
    send({ type: "user_message", text: "Tell me about my trip." });
  }, [send]);

  const buttonStyle: React.CSSProperties = {
    padding: "8px 16px",
    fontSize: 13,
    borderRadius: 6,
    border: "1px solid #444",
    background: "#1a1a1a",
    color: "#fff",
    cursor: "pointer",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.5rem",
        marginTop: "0.5rem",
      }}
    >
      <p style={{ color: "#666", margin: 0, fontSize: 12 }}>
        Stage 2 data-channel tester (also logs to browser console)
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button onClick={injectSnapshot} style={buttonStyle}>
          Inject test snapshot
        </button>
        <button onClick={injectNudge} style={buttonStyle}>
          Inject narration nudge
        </button>
        <button onClick={sendFakeUserMessage} style={buttonStyle}>
          Send fake user message
        </button>
      </div>
      <div
        style={{
          width: "min(640px, 95vw)",
          maxHeight: 220,
          overflowY: "auto",
          marginTop: "0.75rem",
          padding: "0.5rem 0.75rem",
          background: "#0a0a0a",
          border: "1px solid #2a2a2a",
          borderRadius: 6,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11,
          color: "#9cdcfe",
        }}
      >
        <div style={{ color: "#666", marginBottom: 4 }}>
          Inbound data-channel messages ({received.length}):
        </div>
        {received.length === 0 ? (
          <div style={{ color: "#444" }}>(none yet)</div>
        ) : (
          received.map((entry, i) => {
            const isToolCall = entry.msg.type === "tool_call";
            return (
              <div
                key={`${entry.ts}-${i}`}
                style={{
                  padding: "2px 0",
                  borderBottom: i === received.length - 1 ? "none" : "1px solid #1a1a1a",
                  color: isToolCall ? "#4ec9b0" : "#9cdcfe",
                  fontWeight: isToolCall ? 600 : 400,
                }}
              >
                <span style={{ color: "#666" }}>
                  {new Date(entry.ts).toLocaleTimeString()} ← {entry.from}{" "}
                </span>
                {JSON.stringify(entry.msg)}
              </div>
            );
          })
        )}
      </div>
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
          <DataChannelTester />
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
