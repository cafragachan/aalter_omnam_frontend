import { voice, defineAgent, cli, ServerOptions } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as hedra from "@livekit/agents-plugin-hedra";
import { JobContext } from "@livekit/agents";
import { RoomEvent, type RemoteParticipant, type Room } from "@livekit/rtc-node";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

import { buildOmnamTools } from "./tools.js";
import {
  buildOpeningText,
  buildPrompt,
  parseContextInput,
  PLACEHOLDER_OPENING,
  PLACEHOLDER_PROMPT,
} from "./system-prompt.js";

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

    // Stage 3: forward LLM transcripts to the browser over the data
    // channel so lib/livekit/context.tsx can populate its `messages[]`
    // array. Without this, useUserProfile's regex extractor has nothing
    // to read and profile collection is broken on /home-v2.
    //
    // User side: session.on("user_input_transcribed", ...) fires for
    //   every intermediate and final STT result. Filter to isFinal so
    //   we don't publish partials.
    //   (ref: node_modules/@livekit/agents/dist/voice/events.d.ts:50)
    //
    // Assistant side: session.on("conversation_item_added", ...) fires
    //   each time a ChatMessage is added to chat history. The handler
    //   filters on role === "assistant" to skip the system messages we
    //   inject for state_snapshot/narration_nudge and the user messages
    //   published from user_message handler.
    //   (ref: node_modules/@livekit/agents/dist/voice/events.d.ts:84)
    //
    // Both paths call publishTranscript(), which JSON-encodes a
    // `{type:"transcript"}` DataChannelMessage matching the union in
    // lib/livekit/data-channel.ts.
    const transcriptEncoder = new TextEncoder();
    async function publishTranscript(
      role: "user" | "assistant",
      text: string,
    ) {
      const room = ctx.room as Room;
      const trimmed = text.trim();
      if (!trimmed) return;
      const local = room.localParticipant;
      if (!local) {
        console.warn("[agent] publishTranscript: no localParticipant");
        return;
      }
      const payload = transcriptEncoder.encode(
        JSON.stringify({ type: "transcript", role, text: trimmed }),
      );
      try {
        await local.publishData(payload, {
          reliable: true,
          topic: OMNAM_DATA_TOPIC,
        });
      } catch (err) {
        console.error("[agent] publishTranscript failed:", err);
      }
    }

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      publishTranscript("user", ev.transcript);
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.role !== "assistant") return;
      const text = ev.item.textContent;
      if (!text) return;
      publishTranscript("assistant", text);
    });

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
          } else if (type === "ui_event") {
            // Stage 5: forward UI events from the browser (card taps,
            // panel requests, UE5 unit selections, etc.) as system
            // messages so the LLM is aware of off-voice state changes
            // and can react in its next natural turn. The browser-side
            // bridge (lib/livekit/useStateSyncBridge.ts) is responsible
            // for deciding which events are semantically meaningful
            // vs. pure visual polish (FADE_TRANSITION is skipped, etc.).
            const description =
              typeof parsed.description === "string" ? parsed.description : "";
            const eventName =
              typeof parsed.event === "string" ? parsed.event : "unknown";
            if (!description) {
              console.warn(
                `[agent] ui_event (${eventName}) missing description — ignoring`,
              );
            } else {
              const newCtx = session.currentAgent.chatCtx.copy();
              newCtx.addMessage({
                role: "system",
                content: `[UI event: ${eventName}] ${description}`,
              });
              await session.currentAgent.updateChatCtx(newCtx);
              console.log(`[agent] injected ui_event: ${eventName}`);
            }
          } else if (type === "speak") {
            // OpenAI Realtime generates audio directly from the LLM —
            // there's no TTS model for session.say() to drive, and
            // calling it throws "trying to generate speech from text
            // without a TTS model". Route `speak` through the same
            // interrupt + generateReply pattern used for
            // narration_nudge with priority: "interrupt": tell the
            // LLM to voice the text verbatim via the `instructions`
            // field. Slight paraphrasing is expected and aligns with
            // the SPEAK → narration_nudge translation rule in the
            // plan's State Synchronization Protocol section.
            const text = typeof parsed.text === "string" ? parsed.text : "";
            await session.interrupt();
            await session.generateReply({
              instructions: `Say the following to the user, verbatim, with no additions or paraphrasing: "${text}"`,
            });
            console.log("[agent] speak handled via generateReply");
          } else if (type === "interrupt") {
            await session.interrupt();
          }
        } catch (err) {
          console.error(`[agent] handler for "${type}" failed:`, err);
        }
      },
    );

    // Stage 4: build the dynamic persona prompt from the ContextInput JSON
    // carried by the room's metadata. `app/api/start-livekit-session/route.ts`
    // attaches the ContextInput to `AccessToken.roomConfig.metadata`, so when
    // the token is used to auto-create the room, `ctx.room.metadata` contains
    // the serialized ContextInput. If the metadata is missing, malformed, or
    // lacks a firstName we gracefully fall back to the placeholder prompt so
    // the throwaway direct-token /livekit-test path keeps working.
    const rawRoomMetadata = ctx.room.metadata;
    const contextInput = parseContextInput(rawRoomMetadata);
    const instructions = contextInput ? buildPrompt(contextInput) : PLACEHOLDER_PROMPT;
    const openingText = contextInput
      ? buildOpeningText(contextInput)
      : PLACEHOLDER_OPENING;
    if (contextInput) {
      console.log(
        `[agent] built dynamic persona for identity: ${contextInput.identity.firstName}${
          contextInput.identity.lastName ? " " + contextInput.identity.lastName : ""
        } (prompt length: ${instructions.length} chars)`,
      );
    } else {
      console.log(
        `[agent] no valid ContextInput in room metadata (metadata=${
          rawRoomMetadata ? `"${rawRoomMetadata.slice(0, 60)}..."` : "(empty)"
        }) — using placeholder prompt`,
      );
    }

    // Start the agent session.
    // Disable RoomIO audio output so Hedra's DataStreamAudioOutput stays in place
    // (dropping this breaks lip-sync).
    await session.start({
      agent: new voice.Agent({
        instructions,
        // Stage 2 spike: register a single test tool to validate the
        // OpenAI Realtime function-calling pipeline through the
        // @livekit/agents-plugin-openai SDK. Real tools come in Stage 5.
        tools: buildOmnamTools(ctx.room),
      }),
      room: ctx.room,
      outputOptions: { audioEnabled: false },
    });

    // Proactively greet the user. Seed the first turn with the opening text
    // from buildOpeningText() so a returning guest hears "Welcome back,
    // Sarah — when are you thinking of visiting Lake Como?" instead of a
    // generic greeting. The LLM may paraphrase slightly; that's expected
    // and aligns with the SPEAK → narration_nudge rule from the plan.
    await session.generateReply({
      instructions: `Open the conversation by saying something warm along these lines (you may paraphrase slightly to sound natural, but keep the meaning and tone): "${openingText}"`,
    });
  },
});

cli.runApp(new ServerOptions({ agent: __filename }));
