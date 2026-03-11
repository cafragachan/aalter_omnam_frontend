import type { JourneyStage } from "@/lib/context"
import type { UserIntent } from "./intents"
import type { AvatarDerivedProfile } from "@/lib/liveavatar/useUserProfile"

// ---------------------------------------------------------------------------
// Journey State — rich internal state (superset of the 4 public JourneyStages)
// ---------------------------------------------------------------------------

/** Tracks what the avatar last proposed, so a bare "yes" can be resolved contextually */
export type LastProposal = "rooms" | "amenities" | "location" | "book" | "interior_or_exterior"

export type JourneyState =
  | { stage: "PROFILE_COLLECTION"; awaiting: "dates_and_guests" | "dates" | "guests" | "travel_purpose" | "interests" | "extracting" | "ready" }
  | { stage: "DESTINATION_SELECT" }
  | { stage: "VIRTUAL_LOUNGE"; subState: "asking" | "exploring" }
  | { stage: "HOTEL_EXPLORATION"; subState: "announcing" | "awaiting_intent" | "panel_open"; lastProposal?: LastProposal }
  | { stage: "ROOM_SELECTED"; awaiting: "view_choice"; lastProposal?: LastProposal }
  | { stage: "AMENITY_VIEWING" }

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
  | { type: "AMENITY_CARD_TAPPED"; name: string; scene: string; amenityId: string }
  | { type: "IDLE_TIMEOUT" }

// ---------------------------------------------------------------------------
// Effects produced by the reducer — executed by useJourney
// ---------------------------------------------------------------------------

export type JourneyEffect =
  | { type: "SPEAK"; text: string }
  | { type: "UE5_COMMAND"; command: string; value: unknown }
  | { type: "OPEN_PANEL"; panel: "rooms" | "amenities" | "location" }
  | { type: "CLOSE_PANELS" }
  | { type: "FADE_TRANSITION" }
  | { type: "SET_JOURNEY_STAGE"; stage: JourneyStage }
  | { type: "RESET_TO_DEFAULT" }
  | { type: "DOWNLOAD_DATA" }
  | { type: "OPEN_BOOKING_URL" }
  | { type: "SELECT_HOTEL"; slug: string; hotelName: string; location: string; description: string }

// ---------------------------------------------------------------------------
// Reducer result
// ---------------------------------------------------------------------------

export type JourneyResult = {
  nextState: JourneyState
  effects: JourneyEffect[]
}
