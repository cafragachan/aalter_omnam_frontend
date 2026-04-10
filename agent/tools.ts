// Stage 2 of the HeyGen → LiveKit migration: tool catalog for the agent.
//
// The full migration plan lives in
// C:\Users\CesarFragachan\.claude\plans\declarative-crafting-pixel.md
//
// Stage 2 only registers a single test tool — `open_test_panel` — to
// answer the spike question of whether OpenAI Realtime function calling
// works end-to-end through @livekit/agents-plugin-openai @ 1.2.x.
// Real tools are designed in Stage 5.

import { llm } from "@livekit/agents";
import type { Room } from "@livekit/rtc-node";

// Local mirror of the agent → browser message shapes.
//
// The browser-side equivalent lives in lib/livekit/data-channel.ts.
// We can't cross-import because the agent is its own TS project (see
// agent/tsconfig.json) — keep these two files in sync by hand.
type AgentToBrowserMessage =
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "speak"; text: string }
  | { type: "interrupt" };

const encoder = new TextEncoder();

/** Topic name shared by browser and agent. */
const OMNAM_DATA_TOPIC = "omnam";

async function publishToBrowser(
  room: Room,
  message: AgentToBrowserMessage,
): Promise<void> {
  const localParticipant = room.localParticipant;
  if (!localParticipant) {
    console.warn(
      "[tools] dropping message — room has no local participant yet:",
      message.type,
    );
    return;
  }
  const payload = encoder.encode(JSON.stringify(message));
  await localParticipant.publishData(payload, {
    reliable: true,
    topic: OMNAM_DATA_TOPIC,
  });
}

/**
 * Build the Omnam tool catalog. The room is captured by closure so each
 * tool's `execute` callback can publish data-channel messages back to
 * the browser without needing access to the LiveKit Room from inside
 * RunContext (which only exposes AgentSession, not the underlying room).
 */
export function buildOmnamTools(room: Room) {
  return {
    open_test_panel: llm.tool({
      description:
        "Open a UI panel for the user. Use this whenever the user asks to see the rooms, the amenities, or the location of the hotel. Pick the closest matching panel.",
      // Raw JSON Schema literal — the SDK accepts either a Zod object
      // schema or a JSONSchema7. Sticking to JSON Schema avoids pulling
      // zod into agent/ as a direct dependency.
      parameters: {
        type: "object",
        properties: {
          panel: {
            type: "string",
            enum: ["rooms", "amenities", "location"],
            description: "Which panel to open.",
          },
        },
        required: ["panel"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const panel = (args as { panel: "rooms" | "amenities" | "location" })
          .panel;
        try {
          await publishToBrowser(room, {
            type: "tool_call",
            name: "open_test_panel",
            args: { panel },
          });
          console.log(
            `[tools] open_test_panel(${panel}) → published to browser`,
          );
        } catch (err) {
          console.error("[tools] failed to publish tool_call:", err);
        }
        // The string we return becomes the function-call output the LLM
        // sees on its next turn, so it can confirm the action verbally.
        return `Opened the ${panel} panel.`;
      },
    }),
  };
}
