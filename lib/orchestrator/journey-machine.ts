// ---------------------------------------------------------------------------
// Journey State Machine — pure reducer, no React, fully testable
// ---------------------------------------------------------------------------

import type { JourneyState, JourneyAction, JourneyResult, JourneyEffect, AmenityRef, SpeechKey } from "./types"
import type { UserIntent } from "./intents"

// ---------------------------------------------------------------------------
// DEFAULT_SPEECH — Phase 0 extraction of hardcoded SPEAK strings.
// Pure refactor: exact strings preserved. Template-literal cases with ≤2
// runtime params become functions; more complex cases are left inline with a
// TODO(phase-7) comment and will be handled by the speech-renderer.
// ---------------------------------------------------------------------------
export const DEFAULT_SPEECH = {
  downloadData: "Your download should start automatically. May I help with anything else?",
  loungeConfirm: "Return to the virtual lounge? You'll leave the hotel for now.",
  endConfirm: "It was a pleasure hosting you. Would you like to end your experience now?",
  endFarewell: "Thank you for visiting. Goodbye.",
  endCancel: "Certainly. I'm here whenever you need me.",
  loungeWelcomeBack: "Welcome back to the virtual lounge. Say the word when you'd like to revisit the hotel.",
  loungeCancel: "Of course. We'll continue from here. How may I assist?",
  profileReadyWelcome: "Wonderful. Before we head to the hotel, would you like to explore the virtual lounge and its curated art and retail pieces?",
  destinationPicked: (hotelName: string) => `Excellent choice: ${hotelName}. Would you like to explore the lounge first or go straight to the hotel?`,
  loungeExploreAck: "Take your time in the lounge. Tell me when you're ready for the hotel.",
  loungeToHotelIntro: "Welcome to the hotel. You can explore rooms, amenities, or the surrounding area. For ambiance, ask for daylight, sunset, or night, or use the toggle on my right. You can return to the virtual lounge anytime. What would you like to see first?",
  hotelWelcome: "Welcome to the hotel. Would you like to explore rooms, amenities, or the surrounding area? I can also switch to daylight, sunset, or night. To return, simply say 'return to the virtual lounge.'",
  hotelIntroShort: "Welcome to the hotel. Would you like rooms, amenities, or the surrounding area? I can also adjust the lighting.",
  pullUpRooms: "I'll bring up the rooms now. You can refine your selection and explore each option by adjusting the quantities on the right.",
  amenitiesAskWhich: "Which amenity would you like: pool, lobby, or conference room?",
  showLocation: "I'll show you the surrounding area.",
  bookPickRoom: "Certainly. Please choose the room you'd like to book.",
  otherOptionsRooms: "I'll show you the available room options.",
  hotelBackOverview: "Back to the overview. Rooms, amenities, or the area?",
  unknownResponse: "I can't help with that right now, but I can assist with anything related to your stay.",
  unitPicked: (roomName: string) => `Excellent choice: ${roomName}. Would you like to explore this room?`,
  unitExploreDeclined: "Would you like to book this room, view another, or explore other options?",
  unitDeclineClarify: "Certainly. Would you like to book this room, view another, or explore other options?",
  openingBookingPage: "Opening the booking page now. May I assist with anything else?",
  tapGreenUnitFirst: "Tap a highlighted green unit first.",
  steppingInside: "Taking you inside now. Have a look around, and tell me when you're ready to book.",
  exteriorView: "Here's the exterior view. Would you like to book this one or view something else?",
  backToOtherRooms: "Certainly. I'll show you the other available rooms.",
  backToHotelOverview: "Of course. Returning to the hotel overview now.",
  amenityBackToHotel: "Back at the hotel overview. What would you like to explore next?",
  amenitySuggestFallback: (suggestedNext: string) => `Certainly. I'll take you to the ${suggestedNext} now.`,
  amenityFallbackPrompt: "Would you like to see rooms, or explore another part of the hotel?",
  amenityNextNoWorries: "No problem. Would you prefer rooms or the surrounding area next?",
  amenityAskBack: "Shall we head back to the hotel overview?",
  amenityBookNudge: "Excellent. I'll show you the rooms so you can choose your preferred option.",
  amenityPickRooms: "Great choice. I'll show you the rooms.",
  lightingAskWhich: "Certainly. Would you like daylight, sunset, or night?",
  lightingSet: (mode: "daylight" | "sunset" | "night") => {
    if (mode === "daylight") return "Switching to daylight."
    if (mode === "sunset") return "Golden hour it is."
    return "Nightfall - enjoy."
  },
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildAmenityNarrative(name: string, scene: string): string {
  const n = name.toLowerCase()
  const s = scene.toLowerCase()
  if (s.includes("lobby") || n.includes("lobby")) {
    return "a light-filled arrival lounge with plush seating and lakeside calm."
  }
  if (s.includes("conference") || n.includes("conference")) {
    return "a focused meeting space with modern tech and warm lighting."
  }
  if (s.includes("pool") || n.includes("pool")) {
    return "a beautiful pool overlooking the lake."
  }
  return "one of the property's signature spaces."
}

type ProfileCollectionAwaiting = Extract<JourneyState, { stage: "PROFILE_COLLECTION" }>["awaiting"]

export function profileCollectionAwaiting(
  profile: {
    partySize?: number; startDate?: Date | null; endDate?: Date | null;
    travelPurpose?: string; interests: string[];
    guestComposition?: { adults: number; children: number; childrenAges?: number[] };
    roomAllocation?: number[];
  },
): ProfileCollectionAwaiting {
  const missingDates = !profile.startDate || !profile.endDate
  const missingGuests = !profile.partySize

  if (missingDates && missingGuests) return "dates_and_guests"
  if (missingDates) return "dates"
  if (missingGuests) return "guests"
  if (profile.partySize && !profile.guestComposition) return "guest_breakdown"
  // Ask for ages when there are children but ages aren't captured.
  if (
    profile.guestComposition &&
    profile.guestComposition.children > 0 &&
    (!profile.guestComposition.childrenAges || profile.guestComposition.childrenAges.length === 0)
  ) return "children_ages"
  if (!profile.travelPurpose) return "travel_purpose"
  // Solo travelers don't need room distribution
  if ((profile.partySize ?? 1) > 1 && !profile.roomAllocation) return "room_distribution"
  return "ready"
}

// ---------------------------------------------------------------------------
// Amenity helpers
// ---------------------------------------------------------------------------

/** Compute the next unvisited amenity name (if any) */
function computeSuggestedNext(
  allAmenities: AmenityRef[],
  visitedAmenities: string[],
  currentAmenityName: string,
): string | undefined {
  const visited = new Set([...visitedAmenities, currentAmenityName])
  const remaining = allAmenities.filter((a) => !visited.has(a.name))
  return remaining[0]?.name
}

/** Build the AMENITY_VIEWING state with full context */
function buildAmenityViewingState(
  amenity: AmenityRef,
  visitedAmenities: string[],
  allAmenities: AmenityRef[],
): Extract<JourneyState, { stage: "AMENITY_VIEWING" }> {
  return {
    stage: "AMENITY_VIEWING",
    currentAmenity: amenity,
    visitedAmenities: [...visitedAmenities, amenity.name],
    suggestedNext: computeSuggestedNext(allAmenities, visitedAmenities, amenity.name),
    allAmenities,
  }
}

const PURPOSE_NARRATIVE: Record<string, string> = {
  business: "on business",
  leisure: "to unwind",
  "romantic getaway": "for a romantic getaway",
  honeymoon: "for your honeymoon",
  celebration: "to celebrate",
  "family vacation": "for a family holiday",
  adventure: "with adventure in mind",
}

/**
 * Render described-only amenities as a "I can also tell you about ..." tail.
 * Returns an empty string when the list is empty so callers can string-append
 * unconditionally. Lower-cased names follow the same convention as the
 * visited / remaining text in this function.
 */
function buildDescribedOnlyTail(describedOnlyNames?: string[]): string {
  if (!describedOnlyNames || describedOnlyNames.length === 0) return ""
  const lowered = describedOnlyNames.map((n) => n.toLowerCase())
  const listText =
    lowered.length === 1
      ? lowered[0]
      : lowered.slice(0, -1).join(", ") + ` and ${lowered[lowered.length - 1]}`
  return ` We also have ${listText} which I can tell you about, though they're not part of the live tour.`
}

/** Build the speech text for listing amenities (first time, partial, or all visited) */
export function buildAmenityListingSpeech(
  allAmenities: AmenityRef[],
  visitedAmenities: string[],
  travelPurpose?: string,
  recommendedAmenityName?: string,
  describedOnlyAmenityNames?: string[],
): { text: string; suggestedName?: string } {
  const describedTail = buildDescribedOnlyTail(describedOnlyAmenityNames)

  if (allAmenities.length === 0) {
    if (describedTail) {
      // No visitable amenities, but described-only ones exist — pivot to
      // describing those rather than redirecting to rooms.
      return {
        text: `There are no amenity spaces in the live tour right now, but I can tell you about ${(describedOnlyAmenityNames ?? []).map((n) => n.toLowerCase()).join(", ")}. Would you like to hear about one?`,
      }
    }
    return { text: "There are no amenity tours available right now. Would you like to view the rooms instead?" }
  }

  const exploredSet = new Set(visitedAmenities)
  const visited = allAmenities.filter((a) => exploredSet.has(a.name))
  const remaining = allAmenities.filter((a) => !exploredSet.has(a.name))

  // All visited
  if (remaining.length === 0) {
    const visitedText = visited.map((a) => `the ${a.name.toLowerCase()}`).join(", ")
    return { text: `You've seen ${visitedText}.${describedTail} Would you like to revisit one or view rooms?` }
  }

  // Some visited — mention visited, offer remaining
  if (visited.length > 0) {
    const suggestedName = remaining[0].name
    const visitedText = visited.map((a) => `the ${a.name.toLowerCase()}`).join(" and ")
    const remainingText = remaining.length === 1
      ? `the ${remaining[0].name.toLowerCase()}`
      : remaining.map((a) => `the ${a.name.toLowerCase()}`).join(" and ")
    return {
      text: `We've seen ${visitedText}. Next, would you like ${remainingText}?${describedTail}`,
      suggestedName,
    }
  }

  // First time — use recommendation if available
  if (recommendedAmenityName) {
    const recommended = allAmenities.find((a) => a.name.toLowerCase() === recommendedAmenityName.toLowerCase())
    if (recommended) {
      const narrative = PURPOSE_NARRATIVE[travelPurpose?.toLowerCase() ?? ""] ?? ""
      const others = allAmenities.filter((a) => a.id !== recommended.id)
      const othersText = others.length === 1
        ? `a ${others[0].name.toLowerCase()}`
        : others.map((a) => `a ${a.name.toLowerCase()}`).join(" and ")
      return {
        text: `Since you're here ${narrative}, I'd recommend the ${recommended.name.toLowerCase()}. We also have ${othersText}.${describedTail} Which would you prefer?`,
        suggestedName: recommended.name,
      }
    }
  }

  // No recommendation — suggest the first amenity
  const names = allAmenities.map((a) => a.name)
  const suggestedName = names[0]
  const listText = names.length === 1
    ? `a ${names[0].toLowerCase()}`
    : names.slice(0, -1).map((n) => `a ${n.toLowerCase()}`).join(", ") + ` and a ${names[names.length - 1].toLowerCase()}`
  return {
    text: `This property offers ${listText}.${describedTail} Which would you like to visit first?`,
    suggestedName,
  }
}

// ---------------------------------------------------------------------------
// Pilot mode — skip destination selection, default to EDITION Lake Como
// ---------------------------------------------------------------------------

const PILOT_MODE = true

const PILOT_HOTEL = {
  slug: "edition-lake-como",
  hotelName: "EDITION Lake Como",
  location: "Lake Como, Italy",
  description: "Luxury lakeside retreat with stunning mountain views",
}

// ---------------------------------------------------------------------------
// Pre-hotel shortcut — let users skip PROFILE_COLLECTION / VIRTUAL_LOUNGE
// and travel straight to the hotel. Phase 1 (this helper) emits the travel
// effects + an upfront speech. Phase 2 (SHORTCUT_FOLLOWUP / LIST_AMENITIES /
// NAVIGATE_TO_AMENITY) is dispatched ~1.2s later from useJourney so UE5
// has time to finish server-travel before the secondary nav command.
// ---------------------------------------------------------------------------

export type ShortcutTarget = "rooms" | "amenities" | "amenity_by_name" | "location" | "hotel"

export function intentToShortcutTarget(intent: UserIntent): ShortcutTarget | null {
  switch (intent.type) {
    case "ROOMS":
    case "BOOK":            return "rooms"
    case "AMENITIES":       return "amenities"
    case "AMENITY_BY_NAME": return "amenity_by_name"
    case "LOCATION":        return "location"
    case "HOTEL_EXPLORE":
    case "TRAVEL_TO_HOTEL": return "hotel"
    default:                return null
  }
}

function shortcutSpeechKey(
  target: ShortcutTarget,
  fromStage: "PROFILE_COLLECTION" | "VIRTUAL_LOUNGE",
): SpeechKey {
  if (target === "rooms") return "pullUpRooms"
  if (target === "location") return "showLocation"
  // hotel / amenities / amenity_by_name → generic welcome. Phase 2 (LIST_AMENITIES
  // / NAVIGATE_TO_AMENITY) interrupts with its own speech for the amenity cases.
  return fromStage === "PROFILE_COLLECTION" ? "loungeToHotelIntro" : "hotelIntroShort"
}

function buildHotelShortcutResult(
  target: ShortcutTarget,
  fromStage: "PROFILE_COLLECTION" | "VIRTUAL_LOUNGE",
): JourneyResult {
  const effects: JourneyEffect[] = [
    { type: "SELECT_HOTEL", ...PILOT_HOTEL },
    { type: "SET_JOURNEY_STAGE", stage: "HOTEL_EXPLORATION" },
    { type: "UE5_COMMAND", command: "startTEST", value: "startTEST" },
    { type: "FADE_TRANSITION" },
    { type: "SPEAK_INTENT", key: shortcutSpeechKey(target, fromStage) },
  ]
  return {
    nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" },
    effects,
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyResult {
  const effects: JourneyEffect[] = []

  // -----------------------------------------------------------------------
  // IDLE_TIMEOUT — contextual re-engagement (any stage)
  // -----------------------------------------------------------------------
  if (action.type === "IDLE_TIMEOUT") {
    // Terminal states — no re-engagement
    if (state.stage === "PROFILE_COLLECTION" || state.stage === "END_CONFIRMING" || state.stage === "END_EXPERIENCE" || state.stage === "LOUNGE_CONFIRMING") {
      return { nextState: state, effects: [] }
    }
    effects.push({ type: "SPEAK_INTENT", key: "reengage", args: { state } })
    return { nextState: state, effects }
  }

  // -----------------------------------------------------------------------
  // AVATAR_PROPOSAL — update lastProposal based on what the avatar said
  // -----------------------------------------------------------------------
  if (action.type === "AVATAR_PROPOSAL") {
    if (state.stage === "HOTEL_EXPLORATION") {
      return {
        nextState: {
          ...state,
          lastProposal: action.proposal,
          suggestedAmenityName: action.amenityName ?? state.suggestedAmenityName,
        },
        effects: [],
      }
    }
    if (state.stage === "ROOM_SELECTED") {
      return {
        nextState: { ...state, lastProposal: action.proposal },
        effects: [],
      }
    }
    // AMENITY_VIEWING tracks suggestedNext via its own mechanism
    return { nextState: state, effects: [] }
  }

  // -----------------------------------------------------------------------
  // DOWNLOAD_DATA — admin command, works from any stage
  // -----------------------------------------------------------------------
  if (action.type === "USER_INTENT" && action.intent.type === "DOWNLOAD_DATA") {
    effects.push({ type: "SPEAK_INTENT", key: "downloadData" })
    effects.push({ type: "DOWNLOAD_DATA" })
    return { nextState: state, effects }
  }

  // -----------------------------------------------------------------------
  // LIGHTING_CHANGE / LIGHTING_SET — global handlers; only active while the
  // guest is inside the hotel (HOTEL_EXPLORATION / ROOM_SELECTED / AMENITY_VIEWING).
  // When not eligible (PROFILE_COLLECTION / DESTINATION_SELECT / VIRTUAL_LOUNGE),
  // fall through to the stage-specific handlers so their unknown-fallback
  // keeps the turn audible instead of silently dropping the intent.
  // -----------------------------------------------------------------------
  if (
    action.type === "USER_INTENT" &&
    (action.intent.type === "LIGHTING_CHANGE" || action.intent.type === "LIGHTING_SET")
  ) {
    const lightingEligible =
      state.stage === "HOTEL_EXPLORATION" ||
      state.stage === "ROOM_SELECTED" ||
      state.stage === "AMENITY_VIEWING"
    if (lightingEligible) {
      if (action.intent.type === "LIGHTING_CHANGE") {
        effects.push({ type: "SPEAK_INTENT", key: "lightingAskWhich" })
        return { nextState: state, effects }
      }
      const mode = action.intent.mode
      effects.push({ type: "UE5_COMMAND", command: "sunPosition", value: mode })
      effects.push({ type: "SPEAK_INTENT", key: "lightingSet", args: { mode } })
      return { nextState: state, effects }
    }
    // Fall through — the stage handlers below will speak an unknown fallback.
  }

  // -----------------------------------------------------------------------
  // RETURN_TO_LOUNGE — global handler, reachable from exploration stages
  // -----------------------------------------------------------------------
  if (action.type === "USER_INTENT" && action.intent.type === "RETURN_TO_LOUNGE") {
    if (
      state.stage === "VIRTUAL_LOUNGE" || state.stage === "PROFILE_COLLECTION" ||
      state.stage === "DESTINATION_SELECT" || state.stage === "END_CONFIRMING" ||
      state.stage === "END_EXPERIENCE" || state.stage === "LOUNGE_CONFIRMING"
    ) {
      return { nextState: state, effects: [] }
    }
    effects.push({ type: "SPEAK_INTENT", key: "loungeConfirm" })
    return { nextState: { stage: "LOUNGE_CONFIRMING", previousState: state }, effects }
  }

  // -----------------------------------------------------------------------
  // END_EXPERIENCE — global handler, reachable from any stage
  // -----------------------------------------------------------------------
  if (action.type === "USER_INTENT" && action.intent.type === "END_EXPERIENCE") {
    if (state.stage === "END_EXPERIENCE") {
      return { nextState: state, effects: [] }
    }
    // Already in END_CONFIRMING and the user says another farewell —
    // treat it as a re-confirmation (equivalent to AFFIRMATIVE). Otherwise
    // repeated "bye", "I need to go", etc. would be silently swallowed.
    if (state.stage === "END_CONFIRMING") {
      effects.push({ type: "SPEAK_INTENT", key: "endFarewell" })
      effects.push({ type: "STOP_LISTENING" })
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "STOP_AVATAR" })
      effects.push({ type: "HIDE_UE5_STREAM" })
      effects.push({ type: "SET_JOURNEY_STAGE", stage: "END_EXPERIENCE" })
      return { nextState: { stage: "END_EXPERIENCE" }, effects }
    }
    effects.push({ type: "SPEAK_INTENT", key: "endConfirm" })
    return { nextState: { stage: "END_CONFIRMING", previousState: state }, effects }
  }

  // -----------------------------------------------------------------------
  // END_CONFIRMING — awaiting yes/no confirmation
  // -----------------------------------------------------------------------
  if (state.stage === "END_CONFIRMING") {
    if (action.type === "USER_INTENT") {
      const { intent } = action
      if (intent.type === "AFFIRMATIVE") {
        effects.push({ type: "SPEAK_INTENT", key: "endFarewell" })
        effects.push({ type: "STOP_LISTENING" })
        effects.push({ type: "CLOSE_PANELS" })
        effects.push({ type: "STOP_AVATAR" })
        effects.push({ type: "HIDE_UE5_STREAM" })
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "END_EXPERIENCE" })
        return { nextState: { stage: "END_EXPERIENCE" }, effects }
      }
      if (intent.type === "NEGATIVE") {
        effects.push({ type: "SPEAK_INTENT", key: "endCancel" })
        return { nextState: state.previousState, effects }
      }
    }
    // Ignore all other actions while confirming
    return { nextState: state, effects: [] }
  }

  // -----------------------------------------------------------------------
  // LOUNGE_CONFIRMING — awaiting yes/no to return to virtual lounge
  // -----------------------------------------------------------------------
  if (state.stage === "LOUNGE_CONFIRMING") {
    if (action.type === "USER_INTENT") {
      const { intent } = action
      if (intent.type === "AFFIRMATIVE") {
        effects.push({ type: "CLOSE_PANELS" })
        effects.push({ type: "RESET_TO_DEFAULT" })
        effects.push({ type: "UE5_COMMAND", command: "virtualLounge", value: "virtualLounge" })
        effects.push({ type: "FADE_TRANSITION" })
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "VIRTUAL_LOUNGE" })
        effects.push({ type: "SPEAK_INTENT", key: "loungeWelcomeBack" })
        return { nextState: { stage: "VIRTUAL_LOUNGE", subState: "exploring" }, effects }
      }
      if (intent.type === "NEGATIVE") {
        effects.push({ type: "SPEAK_INTENT", key: "loungeCancel" })
        return { nextState: state.previousState, effects }
      }
    }
    // Ignore all other actions while confirming
    return { nextState: state, effects: [] }
  }

  // -----------------------------------------------------------------------
  // END_EXPERIENCE — terminal state, no transitions
  // -----------------------------------------------------------------------
  if (state.stage === "END_EXPERIENCE") {
    return { nextState: state, effects: [] }
  }

  // -----------------------------------------------------------------------
  // PROFILE_COLLECTION
  // -----------------------------------------------------------------------
  if (state.stage === "PROFILE_COLLECTION") {
    // Shortcut — user explicitly asked to see the hotel / rooms / amenities /
    // location / a specific amenity. Skip profile gathering and travel now.
    // useJourney chains the panel-open / amenity dispatch on a 1.2s timer.
    if (action.type === "USER_INTENT") {
      const target = intentToShortcutTarget(action.intent)
      if (target) return buildHotelShortcutResult(target, "PROFILE_COLLECTION")
      // Other intents (AFFIRMATIVE / UNKNOWN / etc.) — silent. Profile
      // collection is conversational; HeyGen's persona handles the turn.
      return { nextState: state, effects: [] }
    }

    // FORCE_ADVANCE — user or HeyGen AI wants to move forward even if profile is incomplete
    if (action.type === "FORCE_ADVANCE") {
      if (PILOT_MODE) {
        effects.push({ type: "SELECT_HOTEL", ...PILOT_HOTEL })
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "VIRTUAL_LOUNGE" })
        effects.push({ type: "STOP_LISTENING" })
        effects.push({ type: "SPEAK_INTENT", key: "profileReadyWelcome" })
        return { nextState: { stage: "VIRTUAL_LOUNGE", subState: "asking" }, effects }
      }

      effects.push({ type: "SET_JOURNEY_STAGE", stage: "DESTINATION_SELECT" })
      return { nextState: { stage: "DESTINATION_SELECT" }, effects }
    }

    if (action.type === "PROFILE_UPDATED") {
      if (action.isExtractionPending) {
        return { nextState: { stage: "PROFILE_COLLECTION", awaiting: "extracting" }, effects: [] }
      }

      const awaiting = profileCollectionAwaiting(action.profile)

      // Profile is complete
      if (awaiting === "ready") {
        if (PILOT_MODE) {
          // Pilot: skip destination selection, offer virtual lounge exploration
          effects.push({ type: "SELECT_HOTEL", ...PILOT_HOTEL })
          effects.push({ type: "SET_JOURNEY_STAGE", stage: "VIRTUAL_LOUNGE" })
          effects.push({ type: "STOP_LISTENING" })
          effects.push({ type: "SPEAK_INTENT", key: "profileReadyWelcome" })
          return { nextState: { stage: "VIRTUAL_LOUNGE", subState: "asking" }, effects }
        }

        // Normal: advance to destination selection
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "DESTINATION_SELECT" })
        return { nextState: { stage: "DESTINATION_SELECT" }, effects }
      }

      // Still collecting — track state silently
      // (HeyGen's AI persona handles the conversation naturally)
      return { nextState: { stage: "PROFILE_COLLECTION", awaiting }, effects: [] }
    }
  }

  // -----------------------------------------------------------------------
  // DESTINATION_SELECT
  // -----------------------------------------------------------------------
  if (state.stage === "DESTINATION_SELECT") {
    if (action.type === "HOTEL_PICKED") {
      const { hotelName } = action

      effects.push({ type: "SET_JOURNEY_STAGE", stage: "VIRTUAL_LOUNGE" })
      effects.push({ type: "STOP_LISTENING" })
      effects.push({ type: "SPEAK_INTENT", key: "destinationPicked", args: { hotelName } })

      return {
        nextState: { stage: "VIRTUAL_LOUNGE", subState: "asking" },
        effects,
      }
    }
  }

  // -----------------------------------------------------------------------
  // VIRTUAL_LOUNGE
  // -----------------------------------------------------------------------
  if (state.stage === "VIRTUAL_LOUNGE") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      if (state.subState === "asking") {
        // User said yes → free-roam the lounge
        if (intent.type === "AFFIRMATIVE") {
          effects.push({ type: "SPEAK_INTENT", key: "loungeExploreAck" })
          return { nextState: { stage: "VIRTUAL_LOUNGE", subState: "exploring" }, effects }
        }

        // Specific content intent (rooms / amenities / location / specific
        // amenity) → travel + remember the target so Phase 2 can navigate.
        const shortcutTarget = intentToShortcutTarget(intent)
        if (shortcutTarget) return buildHotelShortcutResult(shortcutTarget, "VIRTUAL_LOUNGE")

        // Anything else (NEGATIVE, UNKNOWN, etc.) → go to the hotel overview
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "HOTEL_EXPLORATION" })
        effects.push({ type: "UE5_COMMAND", command: "startTEST", value: "startTEST" })
        effects.push({ type: "FADE_TRANSITION" })
        effects.push({ type: "SPEAK_INTENT", key: "loungeToHotelIntro" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
      }

      if (state.subState === "exploring") {
        // User wants to leave the lounge and go to the hotel.
        // AFFIRMATIVE ("yes", "sure", "ok") resolves against the avatar's
        // standing "let me know when you're ready" prompt.
        if (intent.type === "TRAVEL_TO_HOTEL" || intent.type === "NEGATIVE" || intent.type === "AFFIRMATIVE") {
          effects.push({ type: "SET_JOURNEY_STAGE", stage: "HOTEL_EXPLORATION" })
          effects.push({ type: "UE5_COMMAND", command: "startTEST", value: "startTEST" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({ type: "SPEAK_INTENT", key: "hotelWelcome" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
        }

        // Hotel-content intents — user is asking about a specific part of the
        // hotel. Phase 1 travels + speaks; Phase 2 (chained from useJourney
        // ~1.2s later) opens the panel / lists amenities / navigates to the
        // named amenity once UE5 has finished server-travel.
        const shortcutTarget = intentToShortcutTarget(intent)
        if (shortcutTarget) return buildHotelShortcutResult(shortcutTarget, "VIRTUAL_LOUNGE")

        // INTERIOR / EXTERIOR from the lounge — no selected unit yet, so
        // there's nothing to view; treat as a generic "go to the hotel".
        if (intent.type === "INTERIOR" || intent.type === "EXTERIOR") {
          return buildHotelShortcutResult("hotel", "VIRTUAL_LOUNGE")
        }
      }

      // Any other intent while in the lounge — speak a neutral fallback so
      // the turn is audible. Crucially, the SPEAK_INTENT also DRAINS
      // preGeneratedSpeechRef if the =on orchestrate path set it for this
      // turn — without this the LLM-authored speech would either be lost
      // (silent turn) or bleed into a future unrelated SPEAK_INTENT.
      effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
      return { nextState: state, effects }
    }
  }

  // -----------------------------------------------------------------------
  // HOTEL_EXPLORATION
  // -----------------------------------------------------------------------
  if (state.stage === "HOTEL_EXPLORATION") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      switch (intent.type) {
        case "AFFIRMATIVE": {
          // Resolve bare "yes" using what the avatar last proposed (default: rooms)
          // Note: suggestedAmenityName "yes" is intercepted in useJourney before reaching here
          const proposal = state.lastProposal ?? "rooms"
          if (proposal === "rooms" || proposal === "book") {
            // Intercepted in useJourney to check if distribution question is needed
            effects.push({ type: "SPEAK_INTENT", key: "pullUpRooms" })
            effects.push({ type: "OPEN_PANEL", panel: "rooms" })
            return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
          }
          if (proposal === "amenities") {
            // useJourney dispatches LIST_AMENITIES before this can be reached,
            // but as a safety net, prompt for specifics
            effects.push({ type: "SPEAK_INTENT", key: "amenitiesAskWhich" })
            return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
          }
          if (proposal === "location") {
            effects.push({ type: "SPEAK_INTENT", key: "showLocation" })
            effects.push({ type: "OPEN_PANEL", panel: "location" })
            return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
          }
          return { nextState: state, effects: [] }
        }

        case "ROOMS":
          // Note: useJourney intercepts this to check if distribution question is needed first
          effects.push({ type: "SPEAK_INTENT", key: "pullUpRooms" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "AMENITIES":
          // Intercepted in useJourney which dispatches LIST_AMENITIES instead
          return { nextState: state, effects: [] }

        case "AMENITY_BY_NAME":
          // Intercepted in useJourney which dispatches NAVIGATE_TO_AMENITY instead
          return { nextState: state, effects: [] }

        case "LOCATION":
          effects.push({ type: "SPEAK_INTENT", key: "showLocation" })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "BOOK":
          effects.push({ type: "SPEAK_INTENT", key: "bookPickRoom" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "OTHER_OPTIONS":
          effects.push({ type: "SPEAK_INTENT", key: "otherOptionsRooms" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "BACK":
        case "HOTEL_EXPLORE":
        case "TRAVEL_TO_HOTEL":
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "SPEAK_INTENT", key: "hotelBackOverview" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "UNKNOWN":
          effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
          return { nextState: state, effects }

        default:
          // Never silent — see note at VIRTUAL_LOUNGE default above.
          effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
          return { nextState: state, effects }
      }
    }

    if (action.type === "UNIT_SELECTED_UE5") {
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "SPEAK_INTENT", key: "unitPicked", args: { roomName: action.roomName } })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: true, lastProposal: "explore_room" }, effects }
    }

    if (action.type === "SHORTCUT_FOLLOWUP") {
      // Phase 2 of the pre-hotel shortcut. Phase 1 already played the upfront
      // speech (pullUpRooms / showLocation), so this is silent — only opens
      // the panel, which fires the secondary UE5 nav cmd via the bridge.
      effects.push({ type: "OPEN_PANEL", panel: action.target })
      return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
    }

    if (action.type === "AMENITY_CARD_TAPPED") {
      const narrative = buildAmenityNarrative(action.name, action.scene)
      const amenity = { id: action.amenityId, name: action.name, scene: action.scene }
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "UE5_COMMAND", command: "communal", value: action.amenityId })
      effects.push({ type: "FADE_TRANSITION" })
      const nextState = buildAmenityViewingState(amenity, action.visitedAmenities, action.allAmenities)
      const teaser = nextState.suggestedNext ? ` Next: the ${nextState.suggestedNext}?` : ""
      effects.push({ type: "SPEAK_INTENT", key: "amenityNavigate", args: { amenityName: action.name, narrative, teaser } })
      return { nextState, effects }
    }
  }

  // -----------------------------------------------------------------------
  // ROOM_SELECTED
  // -----------------------------------------------------------------------
  if (state.stage === "ROOM_SELECTED") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      switch (intent.type) {
        case "AFFIRMATIVE": {
          // Resolve bare "yes" using what the avatar last proposed (default: book)
          const proposal = state.lastProposal ?? "book"
          if (proposal === "book") {
            effects.push({ type: "SPEAK_INTENT", key: "openingBookingPage" })
            effects.push({ type: "OPEN_BOOKING_URL" })
            return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: state.unitSelected }, effects }
          }
          if (proposal === "explore_room") {
            if (!state.unitSelected) {
              effects.push({ type: "SPEAK_INTENT", key: "tapGreenUnitFirst" })
              return { nextState: state, effects }
            }
            effects.push({ type: "SPEAK_INTENT", key: "steppingInside" })
            effects.push({ type: "UE5_COMMAND", command: "unitView", value: "interior" })
            effects.push({ type: "FADE_TRANSITION" })
            return { nextState: { ...state, lastProposal: "book" }, effects }
          }
          if (proposal === "post_decline_room") {
            // Bare "yes" after the decline menu is ambiguous — re-prompt
            // with the three options (book / another / other) rather than
            // silently picking one.
            effects.push({ type: "SPEAK_INTENT", key: "unitDeclineClarify" })
            return { nextState: state, effects }
          }
          return { nextState: state, effects: [] }
        }

        case "NEGATIVE": {
          if (state.lastProposal === "explore_room") {
            effects.push({ type: "SPEAK_INTENT", key: "unitExploreDeclined" })
            return { nextState: { ...state, lastProposal: "post_decline_room" }, effects }
          }
          if (state.lastProposal === "post_decline_room") {
            // "No" to the clarify re-prompt — ask once more.
            effects.push({ type: "SPEAK_INTENT", key: "unitDeclineClarify" })
            return { nextState: state, effects }
          }
          effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
          return { nextState: state, effects }
        }

        case "INTERIOR":
          if (!state.unitSelected) {
            effects.push({ type: "SPEAK_INTENT", key: "tapGreenUnitFirst" })
            return { nextState: state, effects }
          }
          effects.push({ type: "SPEAK_INTENT", key: "steppingInside" })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "interior" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: { ...state, lastProposal: "book" }, effects }

        case "EXTERIOR":
          if (!state.unitSelected) {
            effects.push({ type: "SPEAK_INTENT", key: "tapGreenUnitFirst" })
            return { nextState: state, effects }
          }
          effects.push({ type: "SPEAK_INTENT", key: "exteriorView" })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "exterior" })
          return { nextState: { ...state, lastProposal: "book" }, effects }

        case "BOOK":
          effects.push({ type: "SPEAK_INTENT", key: "openingBookingPage" })
          effects.push({ type: "OPEN_BOOKING_URL" })
          return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: state.unitSelected }, effects }

        case "BACK":
          effects.push({ type: "SPEAK_INTENT", key: "backToOtherRooms" })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "HOTEL_EXPLORE":
        case "TRAVEL_TO_HOTEL":
          effects.push({ type: "SPEAK_INTENT", key: "backToHotelOverview" })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "OTHER_OPTIONS":
        case "ROOMS":
          effects.push({ type: "SPEAK_INTENT", key: "backToOtherRooms" })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "AMENITIES":
          // Intercepted in useJourney which dispatches LIST_AMENITIES instead
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "AMENITY_BY_NAME":
          // Intercepted in useJourney which dispatches NAVIGATE_TO_AMENITY instead
          // The NAVIGATE_TO_AMENITY handler (below) handles the full transition
          return { nextState: state, effects: [] }

        case "LOCATION":
          effects.push({ type: "SPEAK_INTENT", key: "showLocation" })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "UNKNOWN":
          effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
          return { nextState: state, effects }

        default:
          // Never silent — see note at VIRTUAL_LOUNGE default above.
          effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
          return { nextState: state, effects }
      }
    }

    if (action.type === "UNIT_SELECTED_UE5") {
      effects.push({ type: "SPEAK_INTENT", key: "unitPicked", args: { roomName: action.roomName } })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: true, lastProposal: "explore_room" }, effects }
    }
  }

  // -----------------------------------------------------------------------
  // AMENITY_VIEWING
  // -----------------------------------------------------------------------
  if (state.stage === "AMENITY_VIEWING") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      switch (intent.type) {
        case "BACK":
        case "HOTEL_EXPLORE":
        case "TRAVEL_TO_HOTEL":
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({ type: "SPEAK_INTENT", key: "amenityBackToHotel" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "AFFIRMATIVE":
          // AFFIRMATIVE in AMENITY_VIEWING is ambiguous without knowing what
          // the avatar just proposed — could mean "yes, tell me more about
          // the current amenity" OR "yes, take me to suggestedNext". The
          // LLM (which authored the prior speech) is the only authority
          // that knows which. Under `=on` the LLM emits AMENITY_BY_NAME
          // when advancing or no_action_speak when staying — so reaching
          // this branch means the LLM really meant a bare AFFIRMATIVE.
          // Drain preGen speech (the LLM's authored acknowledgment) and
          // hold state; never silently advance to suggestedNext here.
          effects.push({ type: "SPEAK_INTENT", key: "amenityFallbackPrompt" })
          return { nextState: state, effects }

        case "NEGATIVE":
          if (state.suggestedNext) {
            // "No" to the suggested next amenity
            effects.push({ type: "SPEAK_INTENT", key: "amenityNextNoWorries" })
            return { nextState: { ...state, suggestedNext: undefined }, effects }
          }
          effects.push({ type: "SPEAK_INTENT", key: "amenityAskBack" })
          return { nextState: state, effects }

        case "BOOK":
          effects.push({ type: "SPEAK_INTENT", key: "amenityBookNudge" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "ROOMS":
          effects.push({ type: "SPEAK_INTENT", key: "amenityPickRooms" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "OTHER_OPTIONS":
        case "AMENITIES":
          // Intercepted in useJourney which dispatches LIST_AMENITIES instead
          return { nextState: state, effects: [] }

        case "AMENITY_BY_NAME":
          // Intercepted in useJourney which dispatches NAVIGATE_TO_AMENITY instead
          return { nextState: state, effects: [] }

        case "LOCATION":
          effects.push({ type: "SPEAK_INTENT", key: "showLocation" })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "UNKNOWN":
          effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
          return { nextState: state, effects }

        default:
          // Never silent — see note at VIRTUAL_LOUNGE default above.
          effects.push({ type: "SPEAK_INTENT", key: "unknownResponse" })
          return { nextState: state, effects }
      }
    }
  }

  // -----------------------------------------------------------------------
  // NAVIGATE_TO_AMENITY — global handler, works from any exploration stage
  // -----------------------------------------------------------------------
  if (action.type === "NAVIGATE_TO_AMENITY") {
    const { amenity, narrative, visitedAmenities, allAmenities } = action
    const nextState = buildAmenityViewingState(amenity, visitedAmenities, allAmenities)
    const teaser = nextState.suggestedNext ? ` When you're ready, I can also show you the ${nextState.suggestedNext}.` : ""

    // If coming from a non-amenity state, reset UE5 scene first
    if (state.stage !== "AMENITY_VIEWING") {
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "RESET_TO_DEFAULT" })
    }
    effects.push({ type: "UE5_COMMAND", command: "communal", value: amenity.id })
    effects.push({ type: "FADE_TRANSITION" })
    effects.push({ type: "SPEAK_INTENT", key: "amenityNavigate", args: { amenityName: amenity.name, narrative, teaser } })
    return { nextState, effects }
  }

  // -----------------------------------------------------------------------
  // LIST_AMENITIES — global handler, builds listing speech from action data
  // -----------------------------------------------------------------------
  if (action.type === "LIST_AMENITIES") {
    const { visitedAmenities, allAmenities, travelPurpose, recommendedAmenityName, describedOnlyAmenityNames } = action
    const listing = buildAmenityListingSpeech(
      allAmenities,
      visitedAmenities,
      travelPurpose,
      recommendedAmenityName,
      describedOnlyAmenityNames,
    )
    effects.push({
      type: "SPEAK_INTENT",
      key: "amenityListing",
      args: { allAmenities, visitedAmenities, travelPurpose, recommendedAmenityName, describedOnlyAmenityNames },
    })

    // If currently viewing an amenity, stay in AMENITY_VIEWING with updated suggestedNext
    if (state.stage === "AMENITY_VIEWING") {
      return {
        nextState: { ...state, suggestedNext: listing.suggestedName },
        effects,
      }
    }

    // Otherwise, stay in HOTEL_EXPLORATION with amenity suggestion tracked
    return {
      nextState: {
        stage: "HOTEL_EXPLORATION",
        subState: "awaiting_intent",
        lastProposal: "amenities",
        suggestedAmenityName: listing.suggestedName,
      },
      effects,
    }
  }

  // -----------------------------------------------------------------------
  // Default: no transition
  // -----------------------------------------------------------------------
  return { nextState: state, effects: [] }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const INITIAL_JOURNEY_STATE: JourneyState = {
  stage: "PROFILE_COLLECTION",
  awaiting: "dates_and_guests",
}
