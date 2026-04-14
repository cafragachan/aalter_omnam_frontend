// Stage 5 of the HeyGen → LiveKit migration: full Omnam tool catalog.
//
// The full migration plan lives in
// C:\Users\CesarFragachan\.claude\plans\declarative-crafting-pixel.md
//
// Stage 2 shipped a single spike tool (`open_test_panel`). Stage 5 adds
// the real catalog the LLM uses to drive the /home-v2 journey: panel
// opening, hotel/room/amenity selection, interior/exterior toggles,
// back navigation, and end-of-experience.
//
// Every tool follows the same factory pattern as Stage 2:
//   - buildOmnamTools(room) captures the LiveKit Room by closure.
//   - Each tool's `execute` publishes a `{type:"tool_call", ...}`
//     DataChannelMessage to the browser.
//   - The tool does NOT perform the action itself. Translation into
//     journey actions / EventBus emits happens in
//     lib/livekit/useToolCallBridge.ts on the browser side.
//   - The return string becomes the function-call output the LLM sees
//     on its next turn, so it can acknowledge and narrate.
//
// Kept in sync by hand with lib/livekit/useToolCallBridge.ts. When you
// add/rename/remove a tool here, update that file's switch statement.
//
// The spike tool `open_test_panel` is intentionally preserved for Stage
// 2 regression checks on /livekit-test. Stage 7 will remove it.

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
 * Helper: publish a tool_call payload and log the result. All tools
 * share this helper so the log format + error handling stay uniform.
 */
async function publishToolCall(
  room: Room,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  try {
    await publishToBrowser(room, { type: "tool_call", name, args });
    console.log(`[tools] ${name}(${JSON.stringify(args)}) → published to browser`);
  } catch (err) {
    console.error(`[tools] ${name} publish failed:`, err);
  }
}

/**
 * Build the Omnam tool catalog. The room is captured by closure so each
 * tool's `execute` callback can publish data-channel messages back to
 * the browser without needing access to the LiveKit Room from inside
 * RunContext (which only exposes AgentSession, not the underlying room).
 */
export function buildOmnamTools(room: Room) {
  return {
    // -----------------------------------------------------------------
    // Stage 2 spike tool — kept for /livekit-test debugging.
    // -----------------------------------------------------------------
    open_test_panel: llm.tool({
      description:
        "[Debug/testing only] Open a panel by name. Prefer the specific open_rooms_panel / open_amenities_panel / open_location_panel tools for real user flows.",
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
        await publishToolCall(room, "open_test_panel", { panel });
        return `Opened the ${panel} panel.`;
      },
    }),

    // -----------------------------------------------------------------
    // Panel opening
    // -----------------------------------------------------------------
    open_rooms_panel: llm.tool({
      description:
        "Open the rooms panel for the currently selected hotel. Use this whenever the user asks to see the rooms, the suites, the lofts, or where they will stay. Only call this after a hotel has been selected.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        await publishToolCall(room, "open_rooms_panel", {});
        return "Rooms panel opened. Describe the highlights briefly and invite the user to pick one.";
      },
    }),

    open_amenities_panel: llm.tool({
      description:
        "Open the amenities view. Use when the user asks about amenities, facilities, pool, lobby, conference space, or the hotel's communal areas in general.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        await publishToolCall(room, "open_amenities_panel", {});
        return "Amenities view opened. Briefly mention the standout communal spaces and ask which one the user wants to explore.";
      },
    }),

    open_location_panel: llm.tool({
      description:
        "Open the location / grounds view. Use when the user asks about the location, the surroundings, the outside, the lake, the gardens, or similar.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        await publishToolCall(room, "open_location_panel", {});
        return "Location view opened. Briefly describe what the user is seeing outside.";
      },
    }),

    // -----------------------------------------------------------------
    // Selection
    // -----------------------------------------------------------------
    select_hotel: llm.tool({
      description:
        "Confirm the user's hotel choice. Call this after the user has clearly expressed a preference for a specific property. For the current pilot, only 'edition-lake-como' is available.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            enum: ["edition-lake-como"],
            description:
              "Hotel slug. Only 'edition-lake-como' is active in the pilot.",
          },
        },
        required: ["slug"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const slug = (args as { slug: string }).slug;
        await publishToolCall(room, "select_hotel", { slug });
        return `Hotel ${slug} selected. Welcome the user warmly and offer to show rooms, amenities, or the location.`;
      },
    }),

    select_room: llm.tool({
      description:
        "Select a specific room the user expressed interest in. Pass either the canonical roomId (e.g. 'r3') if you know it, or the human-readable roomName (e.g. 'Loft Suite Lake View') and the client will resolve it. Use when the user names a specific room or clearly picks one from the rooms panel.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Canonical room id if known.",
          },
          roomName: {
            type: "string",
            description:
              "Human-readable room name (fuzzy-matched client-side).",
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const roomId = (args as { roomId?: string }).roomId;
        const roomName = (args as { roomName?: string }).roomName;
        await publishToolCall(room, "select_room", {
          roomId: roomId ?? null,
          roomName: roomName ?? null,
        });
        const label = roomName ?? roomId ?? "selected room";
        return `Room "${label}" selected. Describe one or two distinctive details and ask whether the user wants to see the interior or the exterior.`;
      },
    }),

    navigate_to_amenity: llm.tool({
      description:
        "Navigate to a specific amenity by name. Use when the user names an amenity like 'show me the pool', 'take me to the lobby', or 'conference room please'. The client resolves the amenityName against the active hotel's amenity list.",
      parameters: {
        type: "object",
        properties: {
          amenityName: {
            type: "string",
            description:
              "The amenity name or scene keyword (e.g. 'pool', 'lobby', 'conference').",
          },
        },
        required: ["amenityName"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const amenityName = (args as { amenityName: string }).amenityName;
        await publishToolCall(room, "navigate_to_amenity", { amenityName });
        return `Navigating to ${amenityName}. Briefly set the scene and invite the user to take it in.`;
      },
    }),

    view_unit: llm.tool({
      description:
        "Show the interior or exterior of the currently selected room. Use when the user asks to see inside or outside, or to peek through the window.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["interior", "exterior"],
            description: "Which view to show.",
          },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const mode = (args as { mode: "interior" | "exterior" }).mode;
        await publishToolCall(room, "view_unit", { mode });
        return `Showing the ${mode} view. Add a sensory detail or two.`;
      },
    }),

    // -----------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------
    navigate_back: llm.tool({
      description:
        "Go back ONE STEP within the current hotel experience — for " +
        "example, close a panel and return to the hotel overview, or exit " +
        "a specific room back to the rooms panel. Use this ONLY for small " +
        "in-hotel navigation. DO NOT use this to leave the hotel entirely " +
        "or return to the lounge/home — use return_to_lounge for that.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        await publishToolCall(room, "navigate_back", {});
        return "Back navigation triggered.";
      },
    }),

    end_experience: llm.tool({
      description:
        "End the experience entirely — close the session. Use when the " +
        "guest says 'I'm done', 'goodbye', 'bye', 'that's all', 'I need " +
        "to go', 'see you later', 'thanks that's enough', or similar " +
        "clear farewells. The system will ask the guest to confirm before " +
        "actually ending. Do NOT say 'goodbye' immediately after calling " +
        "this tool — call it, then ask 'Are you sure you'd like to end " +
        "your experience?' and wait for their confirmation. Do NOT " +
        "call this on a simple 'no' answer to another question.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        await publishToolCall(room, "end_experience", {});
        return "Farewell flow triggered. Say a warm goodbye using the user's first name if you know it.";
      },
    }),

    return_to_lounge: llm.tool({
      description:
        "Leave the hotel experience entirely and return to the virtual " +
        "lounge / home / landing area. Use this when the guest says ANY " +
        "of: 'take me back to the lounge', 'go home', 'homepage', " +
        "'landing page', 'return to the intro', 'back to the start', " +
        "'go back to the virtual lounge', or similar phrases suggesting " +
        "they want to EXIT the hotel. The system will ask the guest to " +
        "confirm before actually navigating — do not say 'taking you " +
        "back now'. Instead, call this tool and then say something like " +
        "'Sure — before we head back, just to confirm, you'd like to " +
        "leave the hotel?' and wait for their answer.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        await publishToolCall(room, "return_to_lounge", {});
        return "Return-to-lounge confirmation triggered.";
      },
    }),
  };
}
