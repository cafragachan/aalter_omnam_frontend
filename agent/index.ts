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
//
// Module-scope reference to the latest realtime session, populated by
// createStateSyncController when it acquires the session. Used by the
// uncaughtException handler below for best-effort recovery — the handler
// runs at process scope, so it can't reach the session through the
// AgentSession closure inside `entry`.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let latestRealtimeSession: any = null;

process.on("uncaughtException", (err) => {
  console.error("[agent] uncaughtException — keeping worker alive:", err);

  // SDK-internal error recovery: after certain sequences (double-interrupt,
  // audio_end_ms truncation), the realtime session enters a broken state
  // and stops responding. Try to recover by interrupting the session,
  // which resets its internal response state.
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("item is not a function call") ||
    msg.includes("audio_end_ms")
  ) {
    try {
      const rs = latestRealtimeSession;
      if (rs && typeof rs.interrupt === "function") {
        rs.interrupt();
        console.log(
          "[agent] recovery: interrupted realtime session after SDK internal error",
        );
      } else {
        console.warn(
          "[agent] recovery skipped: no interruptible realtime session available",
        );
      }
    } catch (recoveryErr) {
      console.error("[agent] recovery attempt failed:", recoveryErr);
    }
  }
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
const MAX_RECENT_EVENTS = 6;

interface StateBuffer {
  currentStage: string;
  awaiting: string | null;
  unitSelected: boolean | null;
  profile: Record<string, unknown>;
  selectedHotel: Record<string, unknown> | null;
  lastSelectedRoom: {
    id?: string;
    name: string;
    occupancy?: string;
    price?: string | number;
    viewMode?: "interior" | "exterior" | null;
  } | null;
  recentEvents: string[];
}

function createStateBuffer(): StateBuffer {
  return {
    currentStage: "PROFILE_COLLECTION",
    awaiting: null,
    unitSelected: null,
    profile: {},
    selectedHotel: null,
    lastSelectedRoom: null,
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

  // Detect confirmation stages from recent narration nudges AND tool calls.
  // LOUNGE_CONFIRMING and END_CONFIRMING are internal reducer states
  // that don't surface as public JourneyStages in the state_snapshot,
  // so we infer them from:
  //   1. Recent narration_nudge text (the journey machine's SPEAK effect)
  //   2. Recent tool_call events (return_to_lounge / end_experience)
  // Whichever signal appears most recently wins.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (
      ev.includes("Are you sure you'd like to head back") ||
      ev.includes("return_to_lounge")
    ) {
      return "LOUNGE_CONFIRMING";
    }
    if (
      ev.includes("Are you sure you'd like to end") ||
      ev.includes("end_experience")
    ) {
      return "END_CONFIRMING";
    }
    // Break after the most recent narration/tool-call-style event so we
    // don't scan all the way back past a resolved confirmation.
    if (
      ev.includes("narration_nudge") ||
      ev.includes("SPEAK") ||
      ev.includes("tool_call")
    ) {
      break;
    }
  }

  if (stage !== "HOTEL_EXPLORATION") return stage;

  // Prefer the boolean from state_snapshot when the reducer is in
  // ROOM_SELECTED — it's authoritative. unitSelected is non-null only
  // when the reducer's internal stage is ROOM_SELECTED.
  if (buf.unitSelected !== null) {
    return buf.unitSelected ? "ROOM_VIEWING_UNIT" : "ROOM_SELECTED";
  }

  // Fallback: scan recent events. Used when the snapshot hasn't caught
  // up yet (rapid event bursts before debounced sync) or when the
  // reducer is in a different stage but events still imply a room flow.
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
    case "PROFILE_COLLECTION": {
      const awaiting = buf.awaiting ?? "unknown";
      const fieldQuestions: Record<string, string> = {
        dates_and_guests:
          "Ask the guest for BOTH travel dates AND who will be traveling " +
          "(party size). Do not assume either.",
        dates:
          "Ask the guest for their TRAVEL DATES. This is the most " +
          "important missing piece — do not proceed without getting " +
          "specific dates (e.g., 'May 10-15'). Even if you have " +
          "historical dates from a previous stay, re-ask for THIS " +
          "trip's dates.",
        guests:
          "Ask the guest how many people will be traveling, including " +
          "themselves.",
        guest_breakdown:
          "You have the party size. Now ask for the breakdown — how " +
          "many adults vs children?",
        travel_purpose:
          "Ask the guest what the main purpose of the trip is " +
          "(leisure, family vacation, business, honeymoon, etc.).",
        room_distribution:
          "Ask how the guest would like to arrange rooms — all " +
          "together, or split into multiple rooms?",
      };
      const question =
        fieldQuestions[awaiting] ?? "Continue collecting profile.";
      return (
        "[Action Guide]\n" +
        `You are in PROFILE_COLLECTION and the system is waiting for: ${awaiting}.\n` +
        `Your immediate task: ${question}\n` +
        "\n" +
        "CRITICAL: Do NOT advance to hotel exploration or the virtual " +
        "lounge until every profile field is confirmed in THIS session. " +
        "Even if the persona's historical context suggests you know the " +
        "guest's typical travel pattern, you still need to verbally " +
        "confirm THIS trip's specifics. The system will automatically " +
        "transition stages once all fields are collected.\n" +
        "\n" +
        "Do NOT call open_rooms_panel, open_amenities_panel, or " +
        "open_location_panel while in this stage. Do NOT describe the " +
        "hotel or any rooms yet. Focus ONLY on collecting the missing " +
        "profile field."
      );
    }

    case "VIRTUAL_LOUNGE":
      return (
        "[Action Guide]\n" +
        "The guest is currently in the VIRTUAL LOUNGE — a pre-hotel " +
        "gallery space with exclusive artwork and curated retail " +
        "offerings. They haven't arrived at the hotel yet. Your role " +
        "here is to:\n" +
        "  1. On your first utterance in this stage, offer two choices: " +
        "     (a) explore the lounge — browse the artwork and retail " +
        "     pieces around them, or (b) proceed directly to the hotel.\n" +
        "  2. If the guest says ANYTHING indicating they want to go to " +
        "     the hotel ('take me to the hotel', 'let's go to the " +
        "     hotel', 'skip the lounge', 'head over', 'let's see the " +
        "     hotel', 'proceed', 'lake como please', 'I'm ready', etc.), " +
        "     the journey machine will automatically transition to " +
        "     HOTEL_EXPLORATION — you do NOT need to call any tool, just " +
        "     verbally acknowledge and the system handles it. Say " +
        "     something warm like 'Wonderful, let me take you there now'.\n" +
        "  3. Do NOT describe hotel rooms, amenities, or the location " +
        "     while the guest is still in the lounge. Those are for " +
        "     the next stage.\n" +
        "  4. If the guest is quiet for a while, gently nudge: 'Would " +
        "     you like to explore the lounge a bit, or shall we head " +
        "     over to the hotel?'"
      );

    case "HOTEL_AWAITING_INTENT":
      return (
        "[Action Guide]\n" +
        "The guest just arrived at the hotel. On your very first utterance " +
        "after arrival, you MUST describe all THREE exploration paths in " +
        "one flowing sentence:\n" +
        "  1. The ROOMS (different suites and room types)\n" +
        "  2. The AMENITIES (pool, lobby, conference room — ONLY these three)\n" +
        "  3. The LOCATION and SURROUNDING AREA (grounds and views)\n" +
        "Wait for the guest to choose. Do NOT default to rooms. Do NOT " +
        "call any tool (open_rooms_panel, open_amenities_panel, " +
        "open_location_panel) until the guest expresses a preference.\n" +
        "If the guest says 'take me to the lounge', 'homepage', or 'back " +
        "to the intro', call return_to_lounge.\n" +
        "If the guest says 'I'm done', 'goodbye', 'bye', 'thanks that's " +
        "enough', or similar, call end_experience."
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
        "The guest just selected a ROOM TYPE from the browser panel. " +
        "They have NOT yet selected a specific unit in the 3D view — " +
        "several units of this room type are now highlighted in green " +
        "and the guest needs to tap one to proceed. The [Current " +
        "State] section above tells you which room type " +
        "(Currently selected room: name, sleeps, price) and confirms " +
        "`Specific unit selected in 3D: NO`.\n" +
        "\n" +
        "Your response structure (2-3 short sentences):\n" +
        "  1. Name the room type by its exact name.\n" +
        "  2. One selling point from the ROOM CATALOG.\n" +
        "  3. State capacity and price.\n" +
        "  4. CLEAR call to action: 'You'll see several units " +
        "     highlighted in green — tap any one to step inside and " +
        "     explore it.'\n" +
        "\n" +
        "CRITICAL RULES:\n" +
        "  - Do NOT offer interior view yet.\n" +
        "  - Do NOT offer exterior view yet.\n" +
        "  - Do NOT offer booking yet.\n" +
        "  - If the guest asks 'show me inside' or 'exterior view' " +
        "    before selecting a specific unit, respond: 'Of course — " +
        "    please tap one of the highlighted green units first, and " +
        "    then I can take you inside.' Do NOT call view_unit until " +
        "    a unit is actually selected.\n" +
        "  - Cross-check: if [Current State] says " +
        "    'Specific unit selected in 3D: NO', you MUST follow the " +
        "    rules above.\n" +
        "  - NEVER offer to pick a unit for the guest. The guest picks " +
        "    the unit. Your only role here is to invite them to tap one " +
        "    of the highlighted green units."
      );

    case "ROOM_VIEWING_UNIT":
      return (
        "[Action Guide]\n" +
        "The guest has selected a specific unit in the 3D view " +
        "(Specific unit selected in 3D: YES) and is currently " +
        "viewing the interior or exterior. You can now offer the " +
        "three view-choice actions freely:\n" +
        "  (1) See the OTHER view (interior ↔ exterior — call " +
        "      view_unit)\n" +
        "  (2) Go back to browse other rooms (navigate_back)\n" +
        "  (3) Book this room — ONLY on explicit booking language\n" +
        "\n" +
        "Describe what the guest is seeing in 1-2 sentences of sensory " +
        "detail, then offer the three choices. If the guest has " +
        "already seen both interior and exterior, lean harder into " +
        "booking: 'Would you like to go ahead and reserve this one?'"
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

  if (buf.lastSelectedRoom) {
    const r = buf.lastSelectedRoom;
    const parts: string[] = [`name: "${r.name}"`];
    if (r.occupancy) parts.push(`sleeps: ${r.occupancy}`);
    if (r.price) parts.push(`price: $${r.price}/night`);
    if (r.viewMode) parts.push(`currently viewing: ${r.viewMode}`);
    lines.push(`Currently selected room: ${parts.join(", ")}`);
    if (buf.unitSelected !== null) {
      lines.push(
        `Specific unit selected in 3D: ${buf.unitSelected ? "YES" : "NO"}`,
      );
    }
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
  let lastSyncedInstructions = "";

  async function syncInstructions() {
    syncTimer = null;
    const session = sessionRef.current;
    if (!session) return;

    const summary = formatStateSummary(buf);
    const fullInstructions = originalPrompt + "\n\n" + summary;

    if (fullInstructions === lastSyncedInstructions) {
      return;
    }

    const rtSession = getRealtimeSession(session);
    if (rtSession) {
      // Surface the realtime session to module scope so the
      // uncaughtException recovery handler can interrupt it. Safe to
      // overwrite on every sync — the handler always wants the latest.
      latestRealtimeSession = rtSession;
      try {
        await rtSession.updateInstructions(fullInstructions);
        lastSyncedInstructions = fullInstructions;
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

    // Extract awaiting sub-state (only meaningful during PROFILE_COLLECTION)
    if (p.awaiting === null) {
      buf.awaiting = null;
    } else if (typeof p.awaiting === "string") {
      buf.awaiting = p.awaiting;
    }

    // Extract unitSelected sub-state (only meaningful during ROOM_SELECTED)
    if (p.unitSelected === null) {
      buf.unitSelected = null;
    } else if (typeof p.unitSelected === "boolean") {
      buf.unitSelected = p.unitSelected;
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

  /**
   * Capture room identity into buf.lastSelectedRoom from ui_event payloads.
   * Called in addition to pushEvent so the LLM has structured "which room
   * am I talking about" data, not just a scrollable event log.
   */
  function updateSelectedRoom(
    eventName: string,
    payload: Record<string, unknown> | undefined,
  ) {
    if (!payload) return;
    if (eventName === "ROOM_CARD_TAPPED") {
      buf.lastSelectedRoom = {
        id: typeof payload.roomId === "string" ? payload.roomId : undefined,
        name: String(payload.roomName ?? "unknown"),
        occupancy:
          typeof payload.occupancy === "string" ? payload.occupancy : undefined,
        viewMode: null,
      };
    } else if (eventName === "UNIT_SELECTED_UE5") {
      buf.lastSelectedRoom = {
        id: buf.lastSelectedRoom?.id,
        name: String(payload.roomName ?? buf.lastSelectedRoom?.name ?? "unknown"),
        occupancy: buf.lastSelectedRoom?.occupancy,
        price:
          typeof payload.price === "string" || typeof payload.price === "number"
            ? (payload.price as string | number)
            : undefined,
        viewMode: buf.lastSelectedRoom?.viewMode ?? null,
      };
    } else if (eventName === "VIEW_CHANGE") {
      if (buf.lastSelectedRoom) {
        const v = payload.view;
        buf.lastSelectedRoom.viewMode =
          v === "interior" || v === "exterior" ? v : null;
      }
    }
  }

  return {
    updateFromSnapshot,
    pushEvent,
    updateSelectedRoom,
    flushSync,
    buf,
  };
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
            const payload =
              parsed.payload && typeof parsed.payload === "object"
                ? (parsed.payload as Record<string, unknown>)
                : undefined;
            if (!description) {
              console.warn(
                `[agent] ui_event (${eventName}) missing description — ignoring`,
              );
            } else if (stateSync) {
              stateSync.pushEvent(`[${eventName}] ${description}`);
              stateSync.updateSelectedRoom(eventName, payload);
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

    // Hard session time cap. Audio is 76% of OpenAI spend, so a forced
    // upper bound on session length protects us from forgotten tabs,
    // long silences, and test runs left open. At (cap - 2min) the agent
    // nudges via narration_nudge-equivalent (interrupt + generateReply);
    // at `cap` we disconnect the room which tears the session down.
    const sessionMaxMinutes = Number(
      process.env.AGENT_SESSION_MAX_MINUTES ?? "15",
    );
    const hardCapMs = Math.max(1, sessionMaxMinutes) * 60_000;
    const nudgeAtMs = Math.max(0, hardCapMs - 2 * 60_000);
    const nudgeTimer = setTimeout(async () => {
      console.log("[agent] session time cap approaching");
      try {
        if (stateSync) await stateSync.flushSync();
        await session.interrupt();
        session.generateReply({
          instructions:
            "We've been chatting for a while — shall I wrap things up?",
        });
      } catch (err) {
        console.error("[agent] time-cap nudge failed:", err);
      }
    }, nudgeAtMs);
    const hardCapTimer = setTimeout(async () => {
      console.log("[agent] session time cap reached, closing");
      try {
        await ctx.room.disconnect();
      } catch (err) {
        console.error("[agent] time-cap disconnect failed:", err);
      }
    }, hardCapMs);
    ctx.room.once(RoomEvent.Disconnected, () => {
      clearTimeout(nudgeTimer);
      clearTimeout(hardCapTimer);
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
