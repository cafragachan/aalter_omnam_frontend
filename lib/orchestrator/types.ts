import type { JourneyStage } from "@/lib/context"
import type { UserIntent } from "./intents"
import type { AvatarDerivedProfile } from "@/lib/liveavatar/useUserProfile"

// ---------------------------------------------------------------------------
// TurnDecision envelope (Phase 1 of /home refactor)
//
// Additive, normalized view of whatever the orchestrator decided this turn,
// regardless of which legacy tool fired (navigate_and_speak, profile_turn,
// no_action_speak). The client consumes this alongside the
// existing legacy response fields. Do NOT dispatch on decision yet — that is
// Phase 3. Phase 1 ships it in the wire for shadow-mode groundwork.
// ---------------------------------------------------------------------------

export type TurnDecisionAction =
  // NOTE: `intent` here is the raw intent *tag* as a string (matches the
  // server wire format in app/api/orchestrate/route.ts → buildTurnDecision).
  // This is NOT a full UserIntent object — callers must reconstruct the
  // UserIntent union before handing it to processIntent / the reducer.
  // `amenityName` is surfaced alongside for AMENITY_BY_NAME; `params` is
  // retained for any future intent-specific payload we choose to ship.
  | { type: "USER_INTENT"; intent: string; amenityName?: string; params?: Record<string, unknown> }
  | { type: "ROOM_PLAN_ACTION"; action: string; updates: Record<string, unknown> }
  | {
      type: "PROFILE_TURN_RESULT"
      decision: "ask_next" | "clarify" | "ready"
      awaiting?: string
      profileUpdates?: Record<string, unknown>
    }
  | { type: "NO_ACTION" }
  | null

export type TurnDecisionProposal = {
  kind: "rooms" | "amenity" | "location" | "interior" | "exterior" | "hotel" | "other"
  targetId?: string
  label?: string
}

export type TurnDecision = {
  action: TurnDecisionAction
  speech: string
  reasoning?: string
  proposal?: TurnDecisionProposal
}

// ---------------------------------------------------------------------------
// Journey State — rich internal state (superset of the 4 public JourneyStages)
// ---------------------------------------------------------------------------

/** Tracks what the avatar last proposed, so a bare "yes" can be resolved contextually */
export type LastProposal = "rooms" | "amenities" | "location" | "book" | "interior_or_exterior"

/** Lightweight amenity reference carried in state and actions */
export type AmenityRef = { id: string; name: string; scene: string }

export type JourneyState =
  | { stage: "PROFILE_COLLECTION"; awaiting: "dates_and_guests" | "dates" | "guests" | "guest_breakdown" | "children_ages" | "travel_purpose" | "room_distribution" | "interests" | "extracting" | "ready" }
  | { stage: "DESTINATION_SELECT" }
  | { stage: "VIRTUAL_LOUNGE"; subState: "asking" | "exploring" }
  | { stage: "HOTEL_EXPLORATION"; subState: "announcing" | "awaiting_intent" | "panel_open"; lastProposal?: LastProposal; suggestedAmenityName?: string }
  | { stage: "ROOM_SELECTED"; awaiting: "view_choice"; unitSelected: boolean; lastProposal?: LastProposal }
  | {
      stage: "AMENITY_VIEWING"
      currentAmenity: AmenityRef
      visitedAmenities: string[]
      suggestedNext?: string
      allAmenities: AmenityRef[]
    }
  | { stage: "LOUNGE_CONFIRMING"; previousState: JourneyState }
  | { stage: "END_CONFIRMING"; previousState: JourneyState }
  | { stage: "END_EXPERIENCE" }

// ---------------------------------------------------------------------------
// Actions dispatched into the journey reducer
// ---------------------------------------------------------------------------

export type JourneyAction =
  | { type: "PROFILE_UPDATED"; profile: AvatarDerivedProfile; firstName?: string; isExtractionPending: boolean }
  | { type: "EXTRACTION_COMPLETE" }
  | { type: "FORCE_ADVANCE" }
  | { type: "HOTEL_PICKED"; slug: string; hotelName: string; location: string; description: string }
  | { type: "USER_INTENT"; intent: UserIntent }
  | { type: "ROOM_CARD_TAPPED"; roomName: string; occupancy: string; roomId: string }
  | { type: "UNIT_SELECTED_UE5"; roomName: string }
  | { type: "AMENITY_CARD_TAPPED"; name: string; scene: string; amenityId: string; visitedAmenities: string[]; allAmenities: AmenityRef[] }
  | { type: "IDLE_TIMEOUT" }
  | {
      type: "NAVIGATE_TO_AMENITY"
      amenity: AmenityRef
      narrative: string
      visitedAmenities: string[]
      allAmenities: AmenityRef[]
    }
  | {
      type: "LIST_AMENITIES"
      visitedAmenities: string[]
      allAmenities: AmenityRef[]
      travelPurpose?: string
      recommendedAmenityName?: string
    }
  | { type: "AVATAR_PROPOSAL"; proposal: LastProposal; amenityName?: string }

// ---------------------------------------------------------------------------
// Effects produced by the reducer — executed by useJourney
// ---------------------------------------------------------------------------

// Phase 7 Pass (a): structured speech effect (additive; runs alongside legacy SPEAK).
// The executor prefers SPEAK_INTENT: it consumes preGeneratedSpeechRef if set (LLM
// source) or renders from the key via speech-renderer.ts (rendered source). The
// paired legacy SPEAK is then skipped in the same batch. Pass (b) will drop SPEAK
// from stage logic entirely.
export type SpeechKey =
  // Static keys (each maps directly to a DEFAULT_SPEECH entry)
  | "downloadData"
  | "loungeConfirm"
  | "endConfirm"
  | "endFarewell"
  | "endCancel"
  | "loungeWelcomeBack"
  | "loungeCancel"
  | "profileReadyWelcome"
  | "loungeExploreAck"
  | "loungeToHotelIntro"
  | "hotelWelcome"
  | "hotelIntroShort"
  | "pullUpRooms"
  | "amenitiesAskWhich"
  | "showLocation"
  | "bookPickRoom"
  | "otherOptionsRooms"
  | "hotelBackOverview"
  | "unknownResponse"
  | "openingBookingPage"
  | "tapGreenUnitFirst"
  | "steppingInside"
  | "exteriorView"
  | "backToOtherRooms"
  | "backToHotelOverview"
  | "amenityBackToHotel"
  | "amenityFallbackPrompt"
  | "amenityNextNoWorries"
  | "amenityAskBack"
  | "amenityBookNudge"
  | "amenityPickRooms"
  // Templated keys (args documented in journey-machine.ts SPEAK_INTENT push sites)
  | "destinationPicked"        // args: { hotelName }
  | "roomCardTapped"           // args: { roomName, occupancy }
  | "unitPicked"               // args: { roomName }
  | "amenitySuggestFallback"   // args: { suggestedNext }
  | "amenityNavigate"          // args: { amenityName, narrative, teaser }
  | "amenityListing"           // args: { allAmenities, visitedAmenities, travelPurpose?, recommendedAmenityName? }
  | "reengage"                 // args: { state }
  | "literal"                  // args: { text } — escape hatch for dynamic strings

// Narrowing happens inside the renderer switch; keeping the boundary type loose
// avoids forcing every push site in the reducer to carry a per-key generic.
export type SpeechArgs = Record<string, unknown>

export type JourneyEffect =
  | { type: "SPEAK_INTENT"; key: SpeechKey; args?: SpeechArgs }
  | { type: "UE5_COMMAND"; command: string; value: unknown }
  | { type: "OPEN_PANEL"; panel: "rooms" | "amenities" | "location" }
  | { type: "CLOSE_PANELS" }
  | { type: "FADE_TRANSITION" }
  | { type: "SET_JOURNEY_STAGE"; stage: JourneyStage }
  | { type: "RESET_TO_DEFAULT" }
  | { type: "DOWNLOAD_DATA" }
  | { type: "OPEN_BOOKING_URL" }
  | { type: "SELECT_HOTEL"; slug: string; hotelName: string; location: string; description: string }
  | { type: "STOP_LISTENING" }
  | { type: "STOP_AVATAR" }
  | { type: "HIDE_UE5_STREAM" }

// ---------------------------------------------------------------------------
// Reducer result
// ---------------------------------------------------------------------------

export type JourneyResult = {
  nextState: JourneyState
  effects: JourneyEffect[]
}
