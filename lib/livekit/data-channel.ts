// Stage 2 of the HeyGen → LiveKit migration.
//
// Typed pub/sub helper for the LiveKit data channel — the protocol bus
// between the Omnam browser and the agent process. Used by the throwaway
// test page in Stage 2 and by the full provider in Stages 3-5.
//
// SCOPE LOCK: this file imports ONLY from `livekit-client`. It must not
// touch lib/liveavatar/, lib/orchestrator/, lib/events.ts, or any other
// Omnam folder. It is provider-glue, not application code.
//
// The full migration plan lives in
// C:\Users\CesarFragachan\.claude\plans\declarative-crafting-pixel.md
// See the "State Synchronization Protocol" section for the protocol
// rationale and the message-type catalog.

import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";

/**
 * Wire format of every message that crosses the LiveKit data channel
 * between the Omnam browser and the agent process.
 *
 * Stage 2 only exercises `tool_call`, `state_snapshot`, and
 * `narration_nudge`. The full union is defined now so Stages 3 and 5
 * don't have to widen the type later.
 */
export type DataChannelMessage =
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "state_snapshot"; payload: Record<string, unknown> }
  | {
      type: "narration_nudge";
      intent: string;
      guidance: string;
      priority?: "next_turn" | "interrupt";
    }
  | {
      type: "ui_event";
      event: string;
      description: string;
      payload?: Record<string, unknown>;
    }
  | { type: "user_message"; text: string }
  | { type: "speak"; text: string }
  | { type: "interrupt" };

/** Topic name shared by browser and agent — keep in sync with agent/tools.ts. */
export const OMNAM_DATA_TOPIC = "omnam";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * JSON-encode a message and publish it on the LiveKit data channel.
 *
 * Always uses reliable transport — the protocol prefers correctness over
 * latency, and the message volume is low (a few per second at most).
 *
 * Drops the message with a warning if the room is not connected; this is
 * deliberate, since callers may fire-and-forget during stage transitions
 * before the connection is fully established.
 */
export async function publishMessage(
  room: Room,
  message: DataChannelMessage,
): Promise<void> {
  if (room.state !== "connected") {
    console.warn(
      "[data-channel] dropping message — room not connected:",
      message.type,
    );
    return;
  }
  const payload = encoder.encode(JSON.stringify(message));
  await room.localParticipant.publishData(payload, {
    reliable: true,
    topic: OMNAM_DATA_TOPIC,
  });
}

/**
 * Subscribe to incoming data-channel messages on the given room.
 *
 * Filters by topic so we don't pick up packets from other LiveKit
 * features that may share the channel (chat, transcription, etc.).
 *
 * Returns an unsubscribe function. Decoding errors are logged but do
 * not propagate — a malformed packet from a stale agent should never
 * crash the UI.
 */
export function subscribeToMessages(
  room: Room,
  handler: (
    message: DataChannelMessage,
    participant?: RemoteParticipant,
  ) => void,
): () => void {
  const listener = (
    payload: Uint8Array,
    participant?: RemoteParticipant,
    _kind?: unknown,
    topic?: string,
  ) => {
    if (topic !== undefined && topic !== OMNAM_DATA_TOPIC) {
      return;
    }
    let text: string;
    try {
      text = decoder.decode(payload);
    } catch (err) {
      console.error("[data-channel] failed to decode payload:", err);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.error("[data-channel] failed to parse JSON:", err, text);
      return;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      typeof (parsed as { type: unknown }).type === "string"
    ) {
      handler(parsed as DataChannelMessage, participant);
    } else {
      console.warn("[data-channel] dropped malformed message:", parsed);
    }
  };

  room.on(RoomEvent.DataReceived, listener);
  return () => {
    room.off(RoomEvent.DataReceived, listener);
  };
}
