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

// ---------------------------------------------------------------------------
// Stage 6 Phase A-rev — Rolling-buffer state injection via updateInstructions
// ---------------------------------------------------------------------------
//
// Phase A's batched updateChatCtx() approach did NOT fix the core issue:
// the `previousItemId not found` cascade originates from the SDK's internal
// RemoteChatContext.handleConversationItemCreated, triggered by the
// audio_end_ms bug on speech interruption. Once the SDK's internal
// conversation chain breaks, ALL conversation.item.create calls fail —
// both the SDK's own user/assistant items AND our injected system items.
// Retry/rebase can't help because the corruption is in the SDK's internal
// state, not in our calls.
//
// New approach: abandon updateChatCtx() for state injection entirely.
// Instead, maintain a rolling buffer of current state and recent events,
// and push it into the LLM via RealtimeSession.updateInstructions() —
// which sends a `session.update` event to OpenAI Realtime, replacing the
// session-level instructions. This path does NOT touch the conversation
// item chain (no previousItemId at all), so it's immune to the chain break.
//
// The original persona prompt is preserved as a prefix; the state summary
// is appended after it. On each debounced sync, the full instructions
// string is rebuilt and pushed.
// ---------------------------------------------------------------------------

const SYNC_DEBOUNCE_MS = 300;
const MAX_RECENT_EVENTS = 10;

interface StateBuffer {
  currentStage: string;
  profile: Record<string, unknown>;
  selectedHotel: Record<string, unknown> | null;
  recentEvents: string[];
}

function createStateBuffer(): StateBuffer {
  return {
    currentStage: "PROFILE_COLLECTION",
    profile: {},
    selectedHotel: null,
    recentEvents: [],
  };
}

/**
 * Infer a fine-grained substate from the public JourneyStage + recent events.
 * The state_snapshot only carries the coarse public stage (5 values). Internal
 * states like ROOM_SELECTED and AMENITY_VIEWING map to HOTEL_EXPLORATION
 * publicly. We use the recent events buffer to disambiguate.
 */
function inferSubstate(buf: StateBuffer): string {
  const stage = buf.currentStage;
  const events = buf.recentEvents;

  // Detect confirmation stages from recent narration nudges.
  // LOUNGE_CONFIRMING and END_CONFIRMING are internal reducer states
  // that don't surface as public JourneyStages in the state_snapshot,
  // so we infer them from the most recent narration_nudge content.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.includes("Are you sure you'd like to head back")) {
      return "LOUNGE_CONFIRMING";
    }
    if (ev.includes("Are you sure you'd like to end")) {
      return "END_CONFIRMING";
    }
    // Only check the most recent narration-style event
    if (ev.includes("narration_nudge") || ev.includes("SPEAK")) {
      break;
    }
  }

  if (stage !== "HOTEL_EXPLORATION") return stage;

  // Scan recent events in reverse to find the most recent meaningful one
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    // Room was selected via card tap or UE5 selection
    if (ev.includes("ROOM_CARD_TAPPED") || ev.includes("UNIT_SELECTED_UE5")) {
      // Check if a view change happened after — means they're viewing a unit
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].includes("VIEW_CHANGE")) {
          return "ROOM_VIEWING_UNIT";
        }
      }
      return "ROOM_SELECTED";
    }
    // Amenity was selected
    if (ev.includes("AMENITY_CARD_TAPPED") || ev.includes("Navigating to")) {
      return "AMENITY_VIEWING";
    }
    // Panel was opened
    if (ev.includes("PANEL_REQUESTED")) {
      return "PANEL_OPEN";
    }
    // User navigated back — reset to awaiting
    if (ev.includes("NAVIGATE_BACK")) {
      return "HOTEL_AWAITING_INTENT";
    }
  }

  return "HOTEL_AWAITING_INTENT";
}

/**
 * Stage-aware action guide. Tells the LLM exactly what actions are available
 * at the current stage so it offers the right options instead of generic
 * "would you like to know more?" responses.
 */
function getActionGuide(buf: StateBuffer): string {
  const substate = inferSubstate(buf);

  switch (substate) {
    case "PROFILE_COLLECTION":
      return (
        "[Action Guide]\n" +
        "You are collecting the guest's travel profile. Ask about: travel dates, " +
        "party size, guest breakdown (adults vs children), travel purpose, and " +
        "room distribution preference. Do not offer to show rooms or the hotel " +
        "until all fields are collected."
      );

    case "VIRTUAL_LOUNGE":
      return (
        "[Action Guide]\n" +
        "The guest is in the virtual lounge. Offer to explore the lounge artwork " +
        "and retail, or proceed directly to the hotel. Do not discuss rooms or " +
        "amenities yet."
      );

    case "HOTEL_AWAITING_INTENT":
      return (
        "[Action Guide]\n" +
        "The guest just arrived at the hotel. FIRST, welcome them and " +
        "verbally describe the three things they can explore:\n" +
        "  1. The hotel rooms — different room types and suites\n" +
        "  2. The amenities — pool, lobby, conference space\n" +
        "  3. The location and surrounding grounds\n" +
        "Wait for the guest to express a preference before calling " +
        "any tool. Do NOT immediately open a panel. Let them choose. " +
        "Only call open_rooms_panel, open_amenities_panel, or " +
        "open_location_panel AFTER the guest indicates what they want " +
        "to see.\n" +
        "If the guest says 'go back to the lounge', 'homepage', or " +
        "'take me home', use return_to_lounge.\n" +
        "If the guest says 'I'm done', 'goodbye', or wants to leave, " +
        "use end_experience."
      );

    case "PANEL_OPEN":
      return (
        "[Action Guide]\n" +
        "A panel is currently open (rooms, amenities, or location). Let the " +
        "guest browse. React to their selections. Do not re-open the same panel. " +
        "If they select a room, use select_room. If they ask about a specific " +
        "amenity, use navigate_to_amenity."
      );

    case "ROOM_SELECTED":
      return (
        "[Action Guide]\n" +
        "The guest has selected a room. Offer EXACTLY these options: " +
        "(1) see the interior view (use view_unit with mode 'interior'), " +
        "(2) see the exterior view (use view_unit with mode 'exterior'), or " +
        "(3) proceed to book this room — but only if the guest uses explicit " +
        "booking language (book, reserve, confirm, go ahead). Do NOT offer to " +
        "'tell them more about it' or 'show other rooms' at this point — " +
        "they are looking at a specific unit."
      );

    case "ROOM_VIEWING_UNIT":
      return (
        "[Action Guide]\n" +
        "The guest is viewing the interior or exterior of a room. " +
        "Let them explore freely. When they seem ready, offer to:\n" +
        "  (1) see the other view — interior↔exterior (use view_unit)\n" +
        "  (2) go back to browse more rooms (use navigate_back then " +
        "open_rooms_panel)\n" +
        "  (3) book this room — but ONLY offer this if the guest has " +
        "explicitly expressed interest in booking. Do NOT interpret a " +
        "generic 'yes' or 'sure' as a booking request. The guest must " +
        "say something like 'I want to book this', 'reserve this room', " +
        "'let's go ahead with this one', or 'book it'. A simple " +
        "'yes' in response to 'do you like it?' is NOT a booking " +
        "confirmation.\n" +
        "Only trigger booking when the guest uses explicit booking language " +
        "(book, reserve, confirm, go ahead)."
      );

    case "AMENITY_VIEWING":
      return (
        "[Action Guide]\n" +
        "The guest is viewing a specific amenity. Describe what they're seeing " +
        "with sensory details. When they seem ready, suggest the next amenity " +
        "(use navigate_to_amenity) or offer to return to the hotel overview " +
        "(use navigate_back)."
      );

    case "DESTINATION_SELECT":
      return (
        "[Action Guide]\n" +
        "The guest is selecting a destination. Help them choose from the " +
        "available properties. Use select_hotel when they express a clear preference."
      );

    case "LOUNGE_CONFIRMING":
      return (
        "[Action Guide]\n" +
        "You just asked the guest if they want to return to the " +
        "virtual lounge. Wait for their confirmation. If they say " +
        "yes, confirm, or agree — the system will handle the " +
        "navigation automatically. If they say no or change their " +
        "mind, acknowledge and continue where you left off. Do NOT " +
        "call any tool — the journey machine handles the transition."
      );

    case "END_CONFIRMING":
      return (
        "[Action Guide]\n" +
        "You just asked the guest if they want to end the experience. " +
        "Wait for their answer. If they confirm they want to leave, " +
        "say a warm farewell using their name — the system will " +
        "handle the session end. If they change their mind, " +
        "acknowledge warmly and continue. Do NOT call end_experience " +
        "again — it has already been triggered."
      );

    case "END_EXPERIENCE":
      return (
        "[Action Guide]\n" +
        "The guest is leaving. Say a warm farewell using their name if you know " +
        "it. Do not offer new activities or try to continue the conversation."
      );

    default:
      return "";
  }
}

function formatStateSummary(buf: StateBuffer): string {
  const lines: string[] = [
    "[Important Rules]",
    "- You CANNOT see the 3D environment. Never say 'I can see...' " +
      "or 'Look at that...' — instead say 'You should be seeing...' " +
      "or 'The view will show...'",
    "- Never claim to be physically present in a room or space. " +
      "Say 'This room features...' not 'We're standing in...'",
    "- Only describe what the hotel's data says about a room or " +
      "amenity, not what you imagine is on screen.",
    "- When a view is loading, say 'Let me take you there' not " +
      "'Here we are' — the transition may still be in progress.",
    "- Only trigger booking when the guest uses explicit booking language " +
      "(book, reserve, confirm, go ahead). A generic 'yes' or 'sure' is NOT a booking request.",
    "",
    "[Current State]",
  ];
  lines.push(`Journey stage: ${buf.currentStage}`);

  // Profile summary
  const p = buf.profile as Record<string, unknown>;
  const profileParts: string[] = [];
  if (p.firstName) profileParts.push(String(p.firstName));
  if (p.partySize) profileParts.push(`party of ${p.partySize}`);
  if (p.guestComposition) profileParts.push(`(${p.guestComposition})`);
  if (p.startDate || p.endDate) {
    const start = p.startDate ? String(p.startDate).slice(0, 10) : "?";
    const end = p.endDate ? String(p.endDate).slice(0, 10) : "?";
    profileParts.push(`${start} to ${end}`);
  }
  if (p.travelPurpose) profileParts.push(`purpose: ${p.travelPurpose}`);
  if (p.destination) profileParts.push(`destination: ${p.destination}`);
  if (Array.isArray(p.interests) && p.interests.length > 0) {
    profileParts.push(`interests: ${p.interests.join(", ")}`);
  }
  if (p.budgetRange) profileParts.push(`budget: ${p.budgetRange}`);
  if (p.roomAllocation) profileParts.push(`rooms: ${p.roomAllocation}`);
  if (p.distributionPreference) profileParts.push(`distribution: ${p.distributionPreference}`);
  if (p.dietaryRestrictions) profileParts.push(`dietary: ${p.dietaryRestrictions}`);
  if (p.accessibilityNeeds) profileParts.push(`accessibility: ${p.accessibilityNeeds}`);
  if (p.nationality) profileParts.push(`nationality: ${p.nationality}`);
  if (profileParts.length > 0) {
    lines.push(`Guest: ${profileParts.join(", ")}`);
  }

  if (buf.selectedHotel) {
    const h = buf.selectedHotel as Record<string, unknown>;
    lines.push(`Hotel: ${h.name ?? h.slug ?? "unknown"}`);
  }

  if (buf.recentEvents.length > 0) {
    lines.push("Recent events:");
    for (const ev of buf.recentEvents) {
      lines.push(`- ${ev}`);
    }
  }

  // Stage-aware action guide — tells the LLM what to offer
  const guide = getActionGuide(buf);
  if (guide) {
    lines.push("");
    lines.push(guide);
  }

  return lines.join("\n");
}

/**
 * Access the RealtimeSession from an AgentSession. The path is:
 *   session.currentAgent._agentActivity.realtimeSession
 * Both `_agentActivity` and `realtimeSession` are TypeScript-private
 * (not JS #private), so they're accessible at runtime. We use type
 * assertions to bridge the gap.
 */
function getRealtimeSession(
  session: voice.AgentSession,
): { updateInstructions(instructions: string): Promise<void> } | null {
  try {
    const agent = session.currentAgent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activity = (agent as any)._agentActivity;
    if (!activity) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtSession = (activity as any).realtimeSession;
    if (!rtSession || typeof rtSession.updateInstructions !== "function") return null;
    return rtSession;
  } catch {
    return null;
  }
}

function createStateSyncController(
  sessionRef: { current: voice.AgentSession | null },
  originalPrompt: string,
) {
  const buf = createStateBuffer();
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  async function syncInstructions() {
    syncTimer = null;
    const session = sessionRef.current;
    if (!session) return;

    const summary = formatStateSummary(buf);
    const fullInstructions = originalPrompt + "\n\n" + summary;

    const rtSession = getRealtimeSession(session);
    if (rtSession) {
      try {
        await rtSession.updateInstructions(fullInstructions);
        console.log(
          `[agent] synced instructions (${fullInstructions.length} chars, ` +
            `${buf.recentEvents.length} recent events)`,
        );
      } catch (err) {
        console.error("[agent] updateInstructions failed:", err);
      }
    } else {
      console.warn("[agent] no realtimeSession — cannot sync instructions");
    }
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncInstructions, SYNC_DEBOUNCE_MS);
  }

  /** Flush immediately — used when a side effect (interrupt/generateReply) follows. */
  function flushSync() {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    return syncInstructions();
  }

  function updateFromSnapshot(payload: unknown) {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;

    // Extract stage from the top-level snapshot
    if (typeof p.stage === "string") {
      buf.currentStage = p.stage;
    }

    // Extract profile sub-object
    if (p.profile && typeof p.profile === "object") {
      buf.profile = p.profile as Record<string, unknown>;
    }

    // Extract selectedHotel sub-object
    if (p.selectedHotel && typeof p.selectedHotel === "object") {
      buf.selectedHotel = p.selectedHotel as Record<string, unknown>;
    } else if (p.selectedHotel === null) {
      buf.selectedHotel = null;
    }

    scheduleSync();
  }

  function pushEvent(description: string) {
    buf.recentEvents.push(description);
    if (buf.recentEvents.length > MAX_RECENT_EVENTS) {
      buf.recentEvents.shift();
    }
    scheduleSync();
  }

  return { updateFromSnapshot, pushEvent, flushSync, buf };
}

// formatStateSnapshot removed in Phase A-rev — state injection now goes
// through the rolling-buffer + updateInstructions path, not chat context.

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

    // Stage 2/6: subscribe to inbound data-channel messages from the
    // browser and translate them into agent-side actions.
    //
    // Phase A-rev: state_snapshot, narration_nudge, and ui_event update
    // the rolling state buffer and trigger a debounced
    // updateInstructions() call. No updateChatCtx() — that path is
    // broken by the SDK's internal previousItemId chain corruption.
    //
    // `speak` uses interrupt + generateReply (no chat context mutation).
    // `interrupt` calls session.interrupt() directly.
    // `user_message` calls generateReply() — the LLM already hears the
    //   user's audio via WebRTC, so this is only for text-injected messages.
    //
    // Registered before session.start so it's live as early as possible.
    // The stateSync controller is created after session.start (below)
    // because it needs the realtimeSession to exist.
    const sessionRef = { current: session as voice.AgentSession | null };

    // Placeholder — replaced after session.start() with the real controller
    let stateSync: ReturnType<typeof createStateSyncController> | null = null;

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
            if (stateSync) {
              stateSync.updateFromSnapshot(parsed.payload);
              console.log("[agent] state_snapshot → buffer updated");
            } else {
              console.warn("[agent] state_snapshot before stateSync init — dropped");
            }
          } else if (type === "narration_nudge") {
            const guidance =
              typeof parsed.guidance === "string" ? parsed.guidance : "";
            const intent =
              typeof parsed.intent === "string" ? parsed.intent : "unknown";
            const priority = parsed.priority;

            if (stateSync) {
              stateSync.pushEvent(`Narration [${intent}]: ${guidance}`);
            }
            console.log(
              `[agent] narration_nudge → buffer (priority=${priority ?? "next_turn"})`,
            );

            if (priority === "interrupt") {
              // Flush instructions immediately so the LLM sees the new
              // state, then interrupt + regenerate.
              if (stateSync) await stateSync.flushSync();
              await session.interrupt();
              session.generateReply({ instructions: guidance });
            }
          } else if (type === "user_message") {
            const text = typeof parsed.text === "string" ? parsed.text : "";
            // Flush current state so the LLM has full context for its reply
            if (stateSync) await stateSync.flushSync();
            session.generateReply({
              instructions: `The user sent a text message: "${text}". Respond naturally.`,
            });
            console.log("[agent] user_message → generateReply");
          } else if (type === "ui_event") {
            const description =
              typeof parsed.description === "string" ? parsed.description : "";
            const eventName =
              typeof parsed.event === "string" ? parsed.event : "unknown";
            if (!description) {
              console.warn(
                `[agent] ui_event (${eventName}) missing description — ignoring`,
              );
            } else if (stateSync) {
              stateSync.pushEvent(`[${eventName}] ${description}`);
              console.log(`[agent] ui_event ${eventName} → buffer`);
            }
          } else if (type === "speak") {
            // Time-sensitive: interrupt + generateReply immediately.
            // Flush state first so the LLM has context.
            const text = typeof parsed.text === "string" ? parsed.text : "";
            if (stateSync) await stateSync.flushSync();
            await session.interrupt();
            session.generateReply({
              instructions: `Say the following to the user, verbatim, with no additions or paraphrasing: "${text}"`,
            });
            console.log("[agent] speak → interrupt + generateReply");
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

    // Phase A-rev: now that session.start() has created the RealtimeSession,
    // initialize the state sync controller so data-channel handlers can
    // push state via updateInstructions(). The original persona prompt is
    // preserved as the prefix; state summaries are appended after it.
    stateSync = createStateSyncController(sessionRef, instructions);
    console.log("[agent] stateSyncController initialized");

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
