"use client";

// THROWAWAY TEST PAGE — Stage 1/2/3 of HeyGen → LiveKit migration.
// Will be deleted at Stage 7. Do NOT import from lib/liveavatar/,
// lib/orchestrator/, components/panels/, or any other Omnam folder.
//
// Stage 3: refactored from @livekit/components-react LiveKitRoom to the
// new LiveKitAvatarContextProvider from @/lib/livekit. Exercises the
// full hook surface (useSession.attachElement, useAvatarActions.repeat,
// useAvatarActions.interrupt, useAvatarActions.message) plus the Stage 2
// data-channel tester buttons and an on-screen log box. The Hedra
// avatar video renders via <LiveKitAvatarPlayer/> and the messages[]
// array from the context is displayed separately to prove transcripts
// are being forwarded.

import { useCallback, useEffect, useState } from "react";

import {
  LiveKitAvatarContextProvider,
  MessageSender,
  useAvatarActions,
  useLiveKitAvatarContext,
} from "@/lib/livekit";
import { LiveKitAvatarPlayer } from "@/components/livekit/LiveKitAvatarPlayer";
import {
  publishMessage,
  subscribeToMessages,
  type DataChannelMessage,
} from "@/lib/livekit/data-channel";

const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL!;

// Data-channel tester + hook exerciser + transcript display.
// Lives INSIDE <LiveKitAvatarContextProvider> so its hook calls resolve.
function TestInner() {
  const { sessionRef, sessionState, isStreamReady, messages } =
    useLiveKitAvatarContext();
  const actions = useAvatarActions();
  const [received, setReceived] = useState<
    { ts: number; msg: DataChannelMessage }[]
  >([]);

  useEffect(() => {
    const room = sessionRef.current;
    if (!room) return;
    const unsubscribe = subscribeToMessages(room, (msg) => {
      console.log("[livekit-test] data ←", msg);
      setReceived((prev) =>
        [{ ts: Date.now(), msg }, ...prev].slice(0, 20),
      );
    });
    return unsubscribe;
  }, [sessionRef]);

  const send = useCallback(
    (msg: DataChannelMessage) => {
      const room = sessionRef.current;
      if (!room) return;
      console.log("[livekit-test] data →", msg);
      publishMessage(room, msg).catch((err) =>
        console.error("[livekit-test] publish failed:", err),
      );
    },
    [sessionRef],
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

  const testRepeat = useCallback(() => {
    actions.repeat("Hello from the new LiveKit provider.");
  }, [actions]);

  const testInterrupt = useCallback(() => {
    actions.interrupt();
  }, [actions]);

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
        gap: "1rem",
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          width: 512,
          maxWidth: "100%",
          overflow: "hidden",
          borderRadius: 12,
          background: "#222",
        }}
      >
        <LiveKitAvatarPlayer fit="contain" />
      </div>

      <p style={{ color: "#666", margin: 0, fontSize: 12 }}>
        sessionState: {sessionState} · streamReady: {String(isStreamReady)} ·
        messages: {messages.length}
      </p>

      <p style={{ color: "#666", margin: 0, fontSize: 12 }}>
        Stage 3 provider tester (also logs to browser console)
      </p>
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <button onClick={injectSnapshot} style={buttonStyle}>
          Inject test snapshot
        </button>
        <button onClick={injectNudge} style={buttonStyle}>
          Inject narration nudge
        </button>
        <button onClick={sendFakeUserMessage} style={buttonStyle}>
          Send fake user message
        </button>
        <button onClick={testRepeat} style={buttonStyle}>
          Test repeat()
        </button>
        <button onClick={testInterrupt} style={buttonStyle}>
          Test interrupt()
        </button>
      </div>

      <div
        style={{
          width: "min(640px, 95vw)",
          maxHeight: 180,
          overflowY: "auto",
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
                  borderBottom:
                    i === received.length - 1 ? "none" : "1px solid #1a1a1a",
                  color: isToolCall ? "#4ec9b0" : "#9cdcfe",
                  fontWeight: isToolCall ? 600 : 400,
                }}
              >
                <span style={{ color: "#666" }}>
                  {new Date(entry.ts).toLocaleTimeString()}{" "}
                </span>
                {JSON.stringify(entry.msg)}
              </div>
            );
          })
        )}
      </div>

      <div
        style={{
          width: "min(640px, 95vw)",
          maxHeight: 180,
          overflowY: "auto",
          padding: "0.5rem 0.75rem",
          background: "#0a0a0a",
          border: "1px solid #2a2a2a",
          borderRadius: 6,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11,
          color: "#dcdcaa",
        }}
      >
        <div style={{ color: "#666", marginBottom: 4 }}>
          Transcripts / messages[] from context ({messages.length}):
        </div>
        {messages.length === 0 ? (
          <div style={{ color: "#444" }}>(none yet — speak to the avatar)</div>
        ) : (
          messages.slice(-20).map((m, i) => (
            <div
              key={`${m.timestamp}-${i}`}
              style={{
                padding: "2px 0",
                color: m.sender === MessageSender.USER ? "#9cdcfe" : "#dcdcaa",
              }}
            >
              <span style={{ color: "#666" }}>
                {new Date(m.timestamp).toLocaleTimeString()}{" "}
              </span>
              <strong>{m.sender}:</strong> {m.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Hardcoded fake ContextInput used by the "Connect with fake profile" button.
// The shape mirrors agent/system-prompt.ts's ContextInput — same fields the
// HeyGen path's lib/avatar-context-builder.ts consumes. Stage 5 will replace
// this with a real profile pulled from the logged-in user's Firebase data.
const FAKE_CONTEXT_INPUT = {
  identity: {
    firstName: "Sarah",
    lastName: "Anderson",
    email: "sarah@test.com",
    phoneNumber: "+1-555-0100",
    dateOfBirth: "1988-06-12",
    nationality: "USA",
    languagePreference: "en",
    createdAt: "2026-01-15T00:00:00.000Z",
    lastSeenAt: "2026-04-10T00:00:00.000Z",
  },
  personality: null,
  preferences: null,
  loyalty: null,
};

export default function LiveKitTestPage() {
  const [token, setToken] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string>(LIVEKIT_URL);
  const [connecting, setConnecting] = useState(false);
  const [mode, setMode] = useState<"direct" | "session">("direct");

  // Stage 1/2/3 path — direct /api/livekit-token call. No metadata, so the
  // agent uses its placeholder prompt. Keeps the fallback path exercised.
  const connectDirect = useCallback(async () => {
    setConnecting(true);
    setMode("direct");
    try {
      const newRoomName = `avatar-room-${Date.now()}`;
      const participantName = `user-${Math.random().toString(36).slice(2, 8)}`;

      const res = await fetch("/api/livekit-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: newRoomName, participantName }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setToken(data.token);
      setRoomName(newRoomName);
      setServerUrl(LIVEKIT_URL);
    } catch (err) {
      console.error("Failed to get token:", err);
      alert("Failed to connect. Check console for details.");
    } finally {
      setConnecting(false);
    }
  }, []);

  // Stage 4 path — /api/start-livekit-session with a fake ContextInput body.
  // The route attaches the ContextInput to the room's metadata, so the
  // agent can build a dynamic persona prompt and greet "Sarah" by name.
  const connectWithProfile = useCallback(async () => {
    setConnecting(true);
    setMode("session");
    try {
      const res = await fetch("/api/start-livekit-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(FAKE_CONTEXT_INPUT),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.token || !data.roomName) {
        throw new Error("Session response missing token or roomName");
      }

      setToken(data.token);
      setRoomName(data.roomName);
      setServerUrl(data.serverUrl ?? LIVEKIT_URL);
    } catch (err) {
      console.error("Failed to start session:", err);
      alert("Failed to start session. Check console for details.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setToken(null);
    setRoomName(null);
    setServerUrl(LIVEKIT_URL);
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
        Stage 4 — @/lib/livekit provider + dynamic persona prompt
      </p>

      {!token ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            alignItems: "center",
          }}
        >
          <button
            onClick={connectDirect}
            disabled={connecting}
            style={{
              padding: "12px 32px",
              fontSize: 16,
              borderRadius: 8,
              border: "1px solid #444",
              background: "#1a1a1a",
              color: "#fff",
              cursor: connecting ? "wait" : "pointer",
              minWidth: 320,
            }}
          >
            {connecting && mode === "direct"
              ? "Connecting..."
              : "Connect (direct token, placeholder prompt)"}
          </button>
          <button
            onClick={connectWithProfile}
            disabled={connecting}
            style={{
              padding: "12px 32px",
              fontSize: 16,
              borderRadius: 8,
              border: "none",
              background: "#0070f3",
              color: "#fff",
              cursor: connecting ? "wait" : "pointer",
              minWidth: 320,
              fontWeight: 600,
            }}
          >
            {connecting && mode === "session"
              ? "Starting session..."
              : "Connect with fake profile (Sarah — dynamic prompt)"}
          </button>
          <p style={{ color: "#666", margin: 0, fontSize: 11, maxWidth: 360, textAlign: "center" }}>
            Direct-token path exercises the Stage 1-3 placeholder-prompt fallback.
            The dynamic-prompt path hits /api/start-livekit-session with a
            hardcoded Sarah ContextInput and the agent should greet her by name.
          </p>
        </div>
      ) : (
        <LiveKitAvatarContextProvider
          token={token}
          serverUrl={serverUrl}
          roomName={roomName ?? undefined}
        >
          <TestInner />
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
        </LiveKitAvatarContextProvider>
      )}
    </div>
  );
}
