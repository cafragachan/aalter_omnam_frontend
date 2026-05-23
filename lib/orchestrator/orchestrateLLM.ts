import { z } from "zod"
import type { UserIntent } from "./intents"
import type { JourneyState, TurnDecision } from "./types"
import type { UserDBProfile } from "@/lib/auth-context"
import type {
  HotelCatalogAddress,
  PackedAmenity,
} from "@/lib/hotel-data"
import type {
  PersistedPersonality,
  PersistedPreferences,
  PersistedLoyalty,
} from "@/lib/firebase/types"
import type { ServerTimings } from "@/lib/debug"

/**
 * Per-call timing telemetry stitched onto every successful OrchestrateResult.
 * Powers the human-readable per-session log file in `logs/`. Wall-clock
 * (Date.now ms) on both sides of the wire so client/server segments can be
 * subtracted directly to derive `networkInMs` / `networkOutMs`.
 */
export type OrchestrateTelemetry = {
  /** UUID v4 minted by the caller and threaded through to the server. */
  turnId: string
  /** Date.now ms just before client `fetch("/api/orchestrate")`. */
  clientFetchStartMs: number
  /** Date.now ms after `await res.json()` resolved on the client. */
  clientFetchEndMs: number
  /** Server-side per-segment timestamps echoed back in the response. */
  serverTimings: ServerTimings | null
}

// ---------------------------------------------------------------------------
// Zod schema for the Phase 1 TurnDecision envelope. Validation is advisory:
// failures are logged and the field is dropped. Legacy dispatch continues.
// ---------------------------------------------------------------------------

const ProposalSchema = z.object({
  kind: z.enum(["rooms", "amenity", "location", "interior", "exterior", "hotel", "other"]),
  targetId: z.string().optional(),
  label: z.string().optional(),
})

const TurnDecisionActionSchema = z.union([
  z.object({
    type: z.literal("USER_INTENT"),
    intent: z.string(),
    amenityName: z.string().optional(),
    lightingMode: z.enum(["daylight", "sunset", "night"]).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("PROFILE_TURN_RESULT"),
    decision: z.enum(["ask_next", "clarify", "ready"]),
    awaiting: z.string().optional(),
    profileUpdates: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("NO_ACTION") }),
  z.null(),
])

export const TurnDecisionSchema = z.object({
  action: TurnDecisionActionSchema,
  speech: z.string(),
  reasoning: z.string().optional(),
  proposal: ProposalSchema.optional(),
})

// ---------------------------------------------------------------------------
// OrchestrateResult — discriminated union of the 4 tool types
// ---------------------------------------------------------------------------

export type ProfileUpdates = {
  startDate?: string
  endDate?: string
  partySize?: number
  guestComposition?: { adults: number; children: number; childrenAges?: number[] }
  travelPurpose?: string
  roomAllocation?: number[]
}

export type ProfileTurnDecision = "ask_next" | "clarify" | "ready"

export type OrchestrateResult = (
  | { tool: "navigate_and_speak"; intent: UserIntent; speech: string }
  | { tool: "no_action_speak"; speech: string }
  | {
      tool: "profile_turn"
      reasoning?: string
      profileUpdates: ProfileUpdates
      decision: ProfileTurnDecision
      speech: string
    }
  // ---- Experiment: action-dispatch tools (AMENITY_VIEWING `book` surface).
  // The `text` field on the wire is renamed to `speech` server-side, so client
  // code can treat them uniformly with the legacy speech-carrying tools.
  | { tool: "navigate_to_amenity_action"; amenityId: string; speech: string }
  | { tool: "open_rooms_panel_action"; speech: string }
  | { tool: "speak_only_action"; speech: string }
) & { decision_envelope?: TurnDecision; telemetry?: OrchestrateTelemetry }

// ---------------------------------------------------------------------------
// OrchestrateInput — the context shape sent to the API route
// ---------------------------------------------------------------------------

export interface OrchestrateInput {
  message: string
  state: JourneyState
  guestFirstName?: string
  travelPurpose?: string
  interests?: string[]
  rooms?: { id: string; name: string; occupancy: number; price: number }[]
  selectedRoom?: {
    id: string
    name: string
    occupancy: number
    price: number
    area?: { min_sqm: number; max_sqm: number; label: string }
    roomType?: string
    features?: string[]
    view?: string[]
    bedding?: string[]
    bath?: string[]
    tech?: string[]
    services?: string[]
  }
  /**
   * The actual amenity names available at the currently-selected hotel
   * (e.g., ["Pool", "Lobby", "Conference Room"]). Sent to the orchestrate
   * prompt so the LLM grounds its speech in real property data and doesn't
   * hallucinate amenities from the intent-classification enum (the enum
   * lists pool/spa/restaurant/gym/etc as CATEGORIES, but any given property
   * has a smaller subset). Drives the "only mention these amenities" guard
   * in the HOTEL_EXPLORATION / AMENITY_VIEWING / ROOM_SELECTED prompt block.
   *
   * NOTE: Active amenities only. Superseded by `hotelAmenitiesActive` for
   * richer grounding; kept for backward compatibility.
   */
  hotelAmenityNames?: string[]
  /**
   * Hotel-level info used by the system prompt's hotel-overview block. The
   * LLM draws on this when the guest asks generic property questions
   * ("tell me about this place", "where is it?").
   */
  hotelInfo?: {
    name: string
    location: string
    tagline?: string
    description?: string
    highlights?: string[]
    address?: HotelCatalogAddress
    tags?: string[]
    websiteUrl?: string
  }
  /**
   * Active amenities the guest CAN navigate to (UE5 scenes exist). Each
   * carries shortDescription + highlights + hours so the LLM can describe
   * them without hallucinating, and category for grouping. Long descriptions
   * ride along but are only rendered into the system prompt for the focused
   * amenity (mirrors the rooms / selectedRoom pattern).
   */
  hotelAmenitiesActive?: PackedAmenity[]
  /**
   * Amenities that EXIST at the property but aren't part of the live tour
   * (no UE5 scene). The LLM is instructed to describe them when asked but
   * NEVER to navigate to them. Examples at Lake Como: the Longevity Spa,
   * Cetino, Renzo, the gym, the private dock.
   */
  hotelAmenitiesDescribedOnly?: PackedAmenity[]
  partySize?: number
  budgetRange?: string
  guestComposition?: { adults: number; children: number } | null
  profileAwaiting?: string
  startDate?: string
  endDate?: string
  roomAllocation?: number[]
  identity?: UserDBProfile | null
  personality?: PersistedPersonality | null
  preferences?: PersistedPreferences | null
  loyalty?: PersistedLoyalty | null
  conversationHistory?: { role: "user" | "avatar"; text: string }[]
  /**
   * Phase 3: the regex classifier's best guess for this turn, forwarded as
   * a hint to the LLM. The server prompt instructs the model to treat this
   * as a tiebreaker: prefer it when non-UNKNOWN and unambiguous, override
   * only when the conversation clearly disagrees. Unused during
   * PROFILE_COLLECTION (that stage uses the `profile_turn` tool, not
   * navigation intents).
   */
  regexHint?: string
  /**
   * Optional abort signal so callers can terminate the in-flight fetch
   * when a newer orchestrate call supersedes this one (e.g. fast-path
   * fired, new user turn started, stage transitioned, component unmounted).
   * When the signal aborts, this function returns null without logging.
   */
  signal?: AbortSignal
  /**
   * Caller-supplied UUID for this turn. Threaded through to the server so
   * the per-session log file can correlate client and server timing for
   * the same turn. Required for the latency log to render correctly.
   */
  turnId?: string
  /**
   * Experiment opt-in. When "action-dispatch" AND the server-side stage is
   * AMENITY_VIEWING, the server swaps in three experimental action tools
   * (navigate_to_amenity_action / open_rooms_panel_action / speak_only_action)
   * and `tool_choice: "required"`. See plan `inherited-beaming-gray.md`.
   */
  experiment?: "action-dispatch"
}

// ---------------------------------------------------------------------------
// orchestrateLLM — thin client wrapper
// ---------------------------------------------------------------------------

/**
 * Calls the consolidated /api/orchestrate endpoint.
 * Returns an OrchestrateResult on success, or null if the LLM is unavailable / errors,
 * so the caller can fall back to regex intent + hardcoded speech.
 */
export async function orchestrateLLM(
  input: OrchestrateInput,
): Promise<OrchestrateResult | null> {
  const { message, state, signal, turnId, ...rest } = input

  // Loosened from Record<string, string | undefined> to allow the optional
  // currentAmenity object below (typed { id, name } on the wire).
  const journeyContext: {
    stage: string
    subState?: string
    lastProposal?: string
    suggestedAmenityName?: string
    suggestedNext?: string
    currentAmenity?: { id: string; name: string }
  } = {
    stage: state.stage,
  }

  if ("subState" in state && state.subState) {
    journeyContext.subState = state.subState
  }
  if ("lastProposal" in state && state.lastProposal) {
    journeyContext.lastProposal = state.lastProposal
  }
  if ("suggestedAmenityName" in state && state.suggestedAmenityName) {
    journeyContext.suggestedAmenityName = state.suggestedAmenityName
  }
  if ("suggestedNext" in state && state.suggestedNext) {
    journeyContext.suggestedNext = state.suggestedNext
  }
  // AMENITY_VIEWING carries currentAmenity in its state shape. The server's
  // existing prompt was reusing `suggestedAmenityName` as a hack — pass the
  // real value so the action-dispatch experiment can ground the LLM in the
  // actual currently-viewed amenity. The server reads
  // `journeyContext.currentAmenity` directly.
  if ("currentAmenity" in state && state.currentAmenity) {
    journeyContext.currentAmenity = {
      id: state.currentAmenity.id,
      name: state.currentAmenity.name,
    }
  }

  // Latency log: capture wall-clock at fetch boundary points. Used by the
  // per-session log file in `logs/` to attribute time to the client→server
  // hop, the server, and the server→client hop.
  const clientFetchStartMs = Date.now()

  try {
    const res = await fetch("/api/orchestrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        journeyContext,
        guestFirstName: rest.guestFirstName,
        travelPurpose: rest.travelPurpose,
        interests: rest.interests,
        rooms: rest.rooms,
        selectedRoom: rest.selectedRoom,
        hotelAmenityNames: rest.hotelAmenityNames,
        hotelInfo: rest.hotelInfo,
        hotelAmenitiesActive: rest.hotelAmenitiesActive,
        hotelAmenitiesDescribedOnly: rest.hotelAmenitiesDescribedOnly,
        partySize: rest.partySize,
        budgetRange: rest.budgetRange,
        guestComposition: rest.guestComposition,
        profileAwaiting: rest.profileAwaiting,
        startDate: rest.startDate,
        endDate: rest.endDate,
        roomAllocation: rest.roomAllocation,
        identity: rest.identity,
        personality: rest.personality,
        preferences: rest.preferences,
        loyalty: rest.loyalty,
        conversationHistory: rest.conversationHistory,
        regexHint: rest.regexHint,
        turnId,
        experiment: rest.experiment,
      }),
      signal,
    })

    if (!res.ok) return null

    const data = (await res.json()) as {
      tool: string
      intent?: string
      amenityName?: string
      lightingMode?: "daylight" | "sunset" | "night"
      category?: string
      speech?: string
      reasoning?: string
      profileUpdates?: ProfileUpdates
      decision?: ProfileTurnDecision
      // Experiment: action-dispatch tools carry amenityId on
      // navigate_to_amenity_action.
      amenityId?: string
      // Phase 1 envelope. Optional on the wire — server always emits it,
      // but we treat missing/invalid as soft-warn, not fatal.
      decision_envelope?: unknown
      serverTimings?: ServerTimings
      turnId?: string
    }
    const clientFetchEndMs = Date.now()
    const telemetry: OrchestrateTelemetry | undefined = turnId
      ? {
          turnId: data.turnId ?? turnId,
          clientFetchStartMs,
          clientFetchEndMs,
          serverTimings: data.serverTimings ?? null,
        }
      : undefined

    if (!data.tool || !data.speech) return null

    // Phase 1: validate the envelope. Failures are advisory. The legacy tool
    // field still drives dispatch; the envelope is shadow-groundwork only.
    // Server emits under `decision_envelope` to avoid collision with the
    // profile_turn legacy `decision` enum string.
    const rawEnvelope = data.decision_envelope
    let envelope: TurnDecision | undefined
    if (rawEnvelope !== undefined && rawEnvelope !== null) {
      const parsed = TurnDecisionSchema.safeParse(rawEnvelope)
      if (parsed.success) {
        envelope = parsed.data as TurnDecision
      } else {
        console.warn("[DECISION-ENVELOPE] invalid", {
          tool: data.tool,
          error: parsed.error.flatten(),
        })
      }
    } else {
      console.warn("[DECISION-ENVELOPE] missing or invalid", {
        tool: data.tool,
      })
    }

    const withMeta = <T extends object>(base: T): T & {
      decision_envelope?: TurnDecision
      telemetry?: OrchestrateTelemetry
    } => {
      const out: T & { decision_envelope?: TurnDecision; telemetry?: OrchestrateTelemetry } = { ...base }
      if (envelope) out.decision_envelope = envelope
      if (telemetry) out.telemetry = telemetry
      return out
    }

    if (data.tool === "profile_turn") {
      if (!data.decision) return null
      return withMeta({
        tool: "profile_turn" as const,
        reasoning: data.reasoning,
        profileUpdates: data.profileUpdates ?? {},
        decision: data.decision,
        speech: data.speech,
      })
    }

    if (data.tool === "navigate_and_speak") {
      if (!data.intent) return null
      let intent: UserIntent
      if (data.intent === "AMENITY_BY_NAME" && data.amenityName) {
        intent = { type: "AMENITY_BY_NAME", amenityName: data.amenityName }
      } else if (data.intent === "LIGHTING_SET" && data.lightingMode) {
        intent = { type: "LIGHTING_SET", mode: data.lightingMode }
      } else if (data.intent === "LOCATE_INTEREST_POINTS" && data.category) {
        intent = { type: "LOCATE_INTEREST_POINTS", category: data.category }
      } else {
        intent = { type: data.intent } as UserIntent
      }
      return withMeta({ tool: "navigate_and_speak" as const, intent, speech: data.speech })
    }

    if (data.tool === "no_action_speak") {
      return withMeta({ tool: "no_action_speak" as const, speech: data.speech })
    }

    // Experiment: action-dispatch tools. Speech is already on `data.speech`
    // (server renamed from the tool's `text` field). Skip envelope (server
    // emits a NO_ACTION stub for these; client dispatches on `result.tool`).
    if (data.tool === "navigate_to_amenity_action") {
      if (!data.amenityId) return null
      return withMeta({
        tool: "navigate_to_amenity_action" as const,
        amenityId: data.amenityId,
        speech: data.speech,
      })
    }
    if (data.tool === "open_rooms_panel_action") {
      return withMeta({ tool: "open_rooms_panel_action" as const, speech: data.speech })
    }
    if (data.tool === "speak_only_action") {
      return withMeta({ tool: "speak_only_action" as const, speech: data.speech })
    }

    return null
  } catch (err) {
    // AbortController-triggered termination: the caller explicitly cancelled
    // this request because a newer orchestrate superseded it (fast-path,
    // new turn, stage change, unmount). Return null silently so the caller's
    // response handler can short-circuit without hitting the degraded-mode
    // fallback path (which would speak over the superseding turn).
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      return null
    }
    return null
  }
}
