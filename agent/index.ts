import { voice, defineAgent, cli, ServerOptions } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as hedra from "@livekit/agents-plugin-hedra";
import { JobContext } from "@livekit/agents";
import { RoomEvent, type RemoteParticipant } from "@livekit/rtc-node";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

import { buildOmnamTools } from "./tools.js";

// Load .env.local from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Stage 2 stability guard: keep the worker alive across recoverable SDK
// errors so the throwaway test apparatus survives multiple sessions
// without a manual restart.
//
// `@livekit/agents-plugin-openai@1.2.6` intermittently emits an
// `audio_end_ms: expected integer, got null` error from its internal
// RealtimeSession EventEmitter when speech is interrupted. The SDK
// marks the error `recoverable: true`, but because nothing listens for
// `error` on that emitter, Node escalates it to a process-level
// uncaughtException and the worker dies between test sessions.
// Catching here lets us log and continue. Stage 6+ should pin a fixed
// plugin version or upstream a patch instead of relying on this net.
process.on("uncaughtException", (err) => {
  console.error("[agent] uncaughtException — keeping worker alive:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[agent] unhandledRejection — keeping worker alive:", reason);
});

const decoder = new TextDecoder();
const OMNAM_DATA_TOPIC = "omnam";

/**
 * Render a state_snapshot payload as a single-line, human-readable
 * system message that the LLM can pick up on its next turn.
 *
 * The payload shape is intentionally loose during Stage 2 — it must
 * accept whatever the test page injects (`firstName`, `partySize`,
 * `selectedHotel`, `currentRoom`, `visitedAmenities`). Stage 5 will
 * formalize this against the State Synchronization Protocol.
 */
function formatStateSnapshot(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "(empty snapshot)";
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.firstName === "string") parts.push(`User name: ${p.firstName}`);
  if (typeof p.partySize === "number") parts.push(`party size: ${p.partySize}`);
  if (typeof p.selectedHotel === "string")
    parts.push(`selected hotel: ${p.selectedHotel}`);
  if (typeof p.currentRoom === "string")
    parts.push(`current room: ${p.currentRoom}`);
  if (Array.isArray(p.visitedAmenities) && p.visitedAmenities.length > 0) {
    parts.push(`visited amenities: ${p.visitedAmenities.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : JSON.stringify(p);
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: "gpt-4o-realtime-preview",
        voice: "sage",
        turnDetection: {
          type: "semantic_vad",
          eagerness: "high",
        },
        inputAudioTranscription: { model: "gpt-4o-mini-transcribe" },
      }),
    });

    const avatar = new hedra.AvatarSession({
      avatarId: process.env.HEDRA_AVATAR_ID,
    });

    // Start the avatar and wait for it to join the room
    await avatar.start(session, ctx.room);

    // Stage 2: subscribe to inbound data-channel messages from the
    // browser and translate them into agent-side actions:
    //   - state_snapshot   → inject as system message via updateChatCtx
    //   - narration_nudge  → inject as system message; if priority is
    //                        "interrupt", interrupt + generateReply
    //   - user_message     → inject as user message and trigger reply
    //   - speak            → session.say(text)
    //   - interrupt        → session.interrupt()
    //
    // Registered before session.start so it's live as early as possible.
    ctx.room.on(
      RoomEvent.DataReceived,
      async (
        payload: Uint8Array,
        _participant?: RemoteParticipant,
        _kind?: unknown,
        topic?: string,
      ) => {
        if (topic !== undefined && topic !== OMNAM_DATA_TOPIC) return;

        let parsed: { type?: string; [key: string]: unknown };
        try {
          parsed = JSON.parse(decoder.decode(payload));
        } catch (err) {
          console.error("[agent] failed to parse data channel payload:", err);
          return;
        }
        const type = parsed.type;
        console.log(`[agent] data ← ${type}`, parsed);

        try {
          if (type === "state_snapshot") {
            const text = formatStateSnapshot(parsed.payload);
            const newCtx = session.currentAgent.chatCtx.copy();
            newCtx.addMessage({
              role: "system",
              content: `[Journey state] ${text}`,
            });
            await session.currentAgent.updateChatCtx(newCtx);
            console.log("[agent] injected state_snapshot");
          } else if (type === "narration_nudge") {
            const guidance =
              typeof parsed.guidance === "string" ? parsed.guidance : "";
            const intent =
              typeof parsed.intent === "string" ? parsed.intent : "unknown";
            const priority = parsed.priority;

            const newCtx = session.currentAgent.chatCtx.copy();
            newCtx.addMessage({
              role: "system",
              content: `[Narration nudge: ${intent}] ${guidance}`,
            });
            await session.currentAgent.updateChatCtx(newCtx);
            console.log(
              `[agent] injected narration_nudge (priority=${priority ?? "next_turn"})`,
            );

            if (priority === "interrupt") {
              await session.interrupt();
              session.generateReply({ instructions: guidance });
            }
          } else if (type === "user_message") {
            const text = typeof parsed.text === "string" ? parsed.text : "";
            const newCtx = session.currentAgent.chatCtx.copy();
            newCtx.addMessage({ role: "user", content: text });
            await session.currentAgent.updateChatCtx(newCtx);
            session.generateReply();
            console.log("[agent] injected user_message");
          } else if (type === "speak") {
            const text = typeof parsed.text === "string" ? parsed.text : "";
            session.say(text);
          } else if (type === "interrupt") {
            await session.interrupt();
          }
        } catch (err) {
          console.error(`[agent] handler for "${type}" failed:`, err);
        }
      },
    );

    // Start the agent session.
    // Disable RoomIO audio output so Hedra's DataStreamAudioOutput stays in place
    // (dropping this breaks lip-sync).
    await session.start({
      agent: new voice.Agent({
        instructions:
          "You are Ava, the Omnam concierge. You help guests book luxury hotel experiences. Always respond in English.",
        // Stage 2 spike: register a single test tool to validate the
        // OpenAI Realtime function-calling pipeline through the
        // @livekit/agents-plugin-openai SDK. Real tools come in Stage 5.
        tools: buildOmnamTools(ctx.room),
      }),
      room: ctx.room,
      outputOptions: { audioEnabled: false },
    });

    // Proactively greet the user
    await session.generateReply();
  },
});

cli.runApp(new ServerOptions({ agent: __filename }));
