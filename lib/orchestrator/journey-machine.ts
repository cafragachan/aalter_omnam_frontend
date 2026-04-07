// ---------------------------------------------------------------------------
// Journey State Machine — pure reducer, no React, fully testable
// ---------------------------------------------------------------------------

import type { JourneyState, JourneyAction, JourneyResult, JourneyEffect, AmenityRef } from "./types"
import { getReengagePrompt } from "./reengage-prompts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildAmenityNarrative(name: string, scene: string): string {
  const n = name.toLowerCase()
  const s = scene.toLowerCase()
  if (s.includes("lobby") || n.includes("lobby")) {
    return "we'll step into a grand, light-filled arrival lounge with plush seating and a calm lakeside energy. Is a welcoming lobby space important to you when you arrive?"
  }
  if (s.includes("conference") || n.includes("conference")) {
    return "this conference space is set up for focused meetings with modern tech, warm lighting, and quiet service. Will you be needing any meeting facilities during your stay?"
  }
  if (s.includes("spa") || n.includes("spa")) {
    return "the spa is designed for deep relaxation with lakeside views and holistic treatments. Is wellness something you enjoy on holiday?"
  }
  if (s.includes("restaurant") || n.includes("restaurant") || n.includes("dining")) {
    return "the restaurant serves locally-sourced Italian cuisine with panoramic lake views. Any dietary preferences I should note for your stay?"
  }
  if (s.includes("pool") || n.includes("pool")) {
    return "the pool area has a wonderful setting overlooking the lake. Do you enjoy swimming, or is it more about the lounging and the view?"
  }
  return "it's one of the property's signature spaces, designed for comfort, flow, and a touch of quiet luxury. What do you think?"
}

type ProfileCollectionAwaiting = Extract<JourneyState, { stage: "PROFILE_COLLECTION" }>["awaiting"]

function profileCollectionAwaiting(
  profile: {
    partySize?: number; startDate?: Date | null; endDate?: Date | null;
    travelPurpose?: string; interests: string[];
    guestComposition?: { adults: number; children: number };
    roomAllocation?: number[];
  },
): ProfileCollectionAwaiting {
  const missingDates = !profile.startDate || !profile.endDate
  const missingGuests = !profile.partySize

  if (missingDates && missingGuests) return "dates_and_guests"
  if (missingDates) return "dates"
  if (missingGuests) return "guests"
  if (profile.partySize && !profile.guestComposition) return "guest_breakdown"
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

/** Build the speech text for listing amenities (first time, partial, or all visited) */
function buildAmenityListingSpeech(
  allAmenities: AmenityRef[],
  visitedAmenities: string[],
  travelPurpose?: string,
  recommendedAmenityName?: string,
): { text: string; suggestedName?: string } {
  if (allAmenities.length === 0) {
    return { text: "This property doesn't have any specific amenity spaces to tour right now. Shall we look at the rooms instead?" }
  }

  const exploredSet = new Set(visitedAmenities)
  const visited = allAmenities.filter((a) => exploredSet.has(a.name))
  const remaining = allAmenities.filter((a) => !exploredSet.has(a.name))

  // All visited
  if (remaining.length === 0) {
    const visitedText = visited.map((a) => `the ${a.name.toLowerCase()}`).join(", ")
    return { text: `You've already explored ${visitedText}. Would you like to revisit any of them, or shall we look at the rooms instead?` }
  }

  // Some visited — mention visited, offer remaining
  if (visited.length > 0) {
    const suggestedName = remaining[0].name
    const visitedText = visited.map((a) => `the ${a.name.toLowerCase()}`).join(" and ")
    const remainingText = remaining.length === 1
      ? `the ${remaining[0].name.toLowerCase()}`
      : remaining.map((a) => `the ${a.name.toLowerCase()}`).join(" and ")
    return {
      text: `We've already visited ${visitedText}. Would you like to see ${remainingText} now?`,
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
        text: `Since you're here ${narrative}, I'd suggest starting with the ${recommended.name.toLowerCase()}. We also have ${othersText} that I can take you to. Where shall we begin?`,
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
    text: `This property has ${listText}. Which would you like to visit?`,
    suggestedName,
  }
}

// ---------------------------------------------------------------------------
// Consistent UNKNOWN response — used across all stages to avoid hallucination
// ---------------------------------------------------------------------------

const UNKNOWN_RESPONSE =
  "Unfortunately I can't help with that at this moment. Let me know if I can assist you with anything else regarding your stay."

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
// Reducer
// ---------------------------------------------------------------------------

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyResult {
  const effects: JourneyEffect[] = []

  // -----------------------------------------------------------------------
  // IDLE_TIMEOUT — contextual re-engagement (any stage)
  // -----------------------------------------------------------------------
  if (action.type === "IDLE_TIMEOUT") {
    // During PROFILE_COLLECTION, HeyGen's AI persona handles re-engagement
    if (state.stage === "PROFILE_COLLECTION") {
      return { nextState: state, effects: [] }
    }
    const prompt = getReengagePrompt(state)
    effects.push({ type: "SPEAK", text: prompt })
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
    effects.push({
      type: "SPEAK",
      text: "Of course, the download should happen automatically on your browser. Is there anything else you'd like me to assist with?",
    })
    effects.push({ type: "DOWNLOAD_DATA" })
    return { nextState: state, effects }
  }

  // -----------------------------------------------------------------------
  // PROFILE_COLLECTION
  // -----------------------------------------------------------------------
  if (state.stage === "PROFILE_COLLECTION") {
    // FORCE_ADVANCE — user or HeyGen AI wants to move forward even if profile is incomplete
    if (action.type === "FORCE_ADVANCE") {
      if (PILOT_MODE) {
        effects.push({ type: "SELECT_HOTEL", ...PILOT_HOTEL })
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "VIRTUAL_LOUNGE" })
        effects.push({ type: "STOP_LISTENING" })
        effects.push({
          type: "SPEAK",
          text: "Wonderful! Before we head to the hotel, would you like to explore our virtual lounge? We have some exclusive artwork and unique retail offerings on display.",
        })
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
          effects.push({
            type: "SPEAK",
            text: "Wonderful! Before we head to the hotel, would you like to explore our virtual lounge? We have some exclusive artwork and unique retail offerings on display.",
          })
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
      const { hotelName, description } = action
      const narrative = `${description.charAt(0).toLowerCase()}${description.slice(1)}`

      effects.push({ type: "SET_JOURNEY_STAGE", stage: "VIRTUAL_LOUNGE" })
      effects.push({ type: "STOP_LISTENING" })
      effects.push({
        type: "SPEAK",
        text: `Excellent choice — the ${hotelName}, ${narrative}. Before we head there, would you like to explore our virtual lounge? We have some exclusive artwork and unique retail offerings on display.`,
      })

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
          effects.push({
            type: "SPEAK",
            text: "Great, feel free to navigate around the space pointing and clicking throughout the gallery. Let me know if you require any further assistance.",
          })
          return { nextState: { stage: "VIRTUAL_LOUNGE", subState: "exploring" }, effects }
        }

        // Anything else (NEGATIVE, TRAVEL_TO_HOTEL, UNKNOWN, etc.) → go to the hotel
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "HOTEL_EXPLORATION" })
        effects.push({ type: "UE5_COMMAND", command: "startTEST", value: "startTEST" })
        effects.push({ type: "FADE_TRANSITION" })
        effects.push({
          type: "SPEAK",
          text: "Let me take you to the hotel. You can explore available rooms, check out the amenities, or wander the surrounding area. What would you like to see first?",
        })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
      }

      if (state.subState === "exploring") {
        // User wants to leave the lounge and go to the hotel
        if (intent.type === "TRAVEL_TO_HOTEL" || intent.type === "NEGATIVE") {
          effects.push({ type: "SET_JOURNEY_STAGE", stage: "HOTEL_EXPLORATION" })
          effects.push({ type: "UE5_COMMAND", command: "startTEST", value: "startTEST" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({
            type: "SPEAK",
            text: "Let me take you to the hotel. You can explore available rooms, check out the amenities, or wander the surrounding area. What would you like to see first?",
          })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
        }

      }

      // Any other intent while in the lounge — ignore silently
      return { nextState: state, effects: [] }
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
            effects.push({ type: "SPEAK", text: "Let me pull up the available rooms." })
            effects.push({ type: "OPEN_PANEL", panel: "rooms" })
            return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
          }
          if (proposal === "amenities") {
            // useJourney dispatches LIST_AMENITIES before this can be reached,
            // but as a safety net, prompt for specifics
            effects.push({ type: "SPEAK", text: "Which amenity would you like to visit? I can show you the options." })
            return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
          }
          if (proposal === "location") {
            effects.push({ type: "SPEAK", text: "Let me show you the surrounding area." })
            effects.push({ type: "OPEN_PANEL", panel: "location" })
            return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
          }
          return { nextState: state, effects: [] }
        }

        case "ROOMS":
          // Note: useJourney intercepts this to check if distribution question is needed first
          effects.push({ type: "SPEAK", text: "Let me pull up the available rooms. I'll suggest the best fit based on your group size." })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "AMENITIES":
          // Intercepted in useJourney which dispatches LIST_AMENITIES instead
          return { nextState: state, effects: [] }

        case "AMENITY_BY_NAME":
          // Intercepted in useJourney which dispatches NAVIGATE_TO_AMENITY instead
          return { nextState: state, effects: [] }

        case "LOCATION":
          effects.push({ type: "SPEAK", text: "Let me show you the surrounding area. It's worth seeing what's nearby — there are some wonderful spots." })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "BOOK":
          effects.push({ type: "SPEAK", text: "I'd love to help you book! Let me show you the available rooms first — pick the one that catches your eye." })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "OTHER_OPTIONS":
          effects.push({ type: "SPEAK", text: "Let me pull up the available rooms." })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "BACK":
        case "HOTEL_EXPLORE":
        case "TRAVEL_TO_HOTEL":
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "SPEAK", text: "Back to the hotel overview. What would you like to explore next — rooms, amenities, or the area?" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "UNKNOWN":
          effects.push({ type: "SPEAK", text: UNKNOWN_RESPONSE })
          return { nextState: state, effects }

        default:
          return { nextState: state, effects: [] }
      }
    }

    if (action.type === "ROOM_CARD_TAPPED") {
      const { roomName, occupancy, roomId } = action
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "UE5_COMMAND", command: "selectedRoom", value: roomId })
      effects.push({
        type: "SPEAK",
        text: `The ${roomName} accommodates up to ${occupancy} guests. Select one of the highlighted green units to explore it.`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: false }, effects }
    }

    if (action.type === "UNIT_SELECTED_UE5") {
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({
        type: "SPEAK",
        text: `Great pick! The ${action.roomName} is a wonderful choice. Would you like to explore the interior or see the exterior view first?`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: true, lastProposal: "interior_or_exterior" }, effects }
    }

    if (action.type === "AMENITY_CARD_TAPPED") {
      const narrative = buildAmenityNarrative(action.name, action.scene)
      const amenity = { id: action.amenityId, name: action.name, scene: action.scene }
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "UE5_COMMAND", command: "communal", value: action.amenityId })
      effects.push({ type: "FADE_TRANSITION" })
      const nextState = buildAmenityViewingState(amenity, action.visitedAmenities, action.allAmenities)
      const teaser = nextState.suggestedNext ? ` When you're ready, I can also show you the ${nextState.suggestedNext}.` : ""
      effects.push({ type: "SPEAK", text: `Let me take you to the ${action.name} — ${narrative}${teaser}` })
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
            effects.push({ type: "SPEAK", text: "I'm opening the booking page for you now. You'll be able to complete your reservation directly on the hotel's website. Is there anything else you'd like to explore?" })
            effects.push({ type: "OPEN_BOOKING_URL" })
            return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: state.unitSelected }, effects }
          }
          if (proposal === "interior_or_exterior") {
            if (!state.unitSelected) {
              effects.push({ type: "SPEAK", text: "Please select a unit first by clicking on one of the highlighted options in the view." })
              return { nextState: state, effects }
            }
            effects.push({ type: "SPEAK", text: "Stepping inside — take a look around. Feel free to navigate through the space. Let me know if you have any specific requirements, or if you'd like to book this room, just say the word." })
            effects.push({ type: "UE5_COMMAND", command: "unitView", value: "interior" })
            effects.push({ type: "FADE_TRANSITION" })
            return { nextState: { ...state, lastProposal: "book" }, effects }
          }
          return { nextState: state, effects: [] }
        }

        case "INTERIOR":
          if (!state.unitSelected) {
            effects.push({ type: "SPEAK", text: "Please select a unit first by clicking on one of the highlighted options in the view." })
            return { nextState: state, effects }
          }
          effects.push({ type: "SPEAK", text: "Stepping inside — take a look around. Feel free to navigate through the space. Let me know if you have any specific requirements, or if you'd like to book this room, just say the word." })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "interior" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: { ...state, lastProposal: "book" }, effects }

        case "EXTERIOR":
          if (!state.unitSelected) {
            effects.push({ type: "SPEAK", text: "Please select a unit first by clicking on one of the highlighted options in the view." })
            return { nextState: state, effects }
          }
          effects.push({ type: "SPEAK", text: "Here's the exterior view. The perspective from this floor is quite special. Would you like to book this room, or explore something else?" })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "exterior" })
          return { nextState: { ...state, lastProposal: "book" }, effects }

        case "BOOK":
          effects.push({ type: "SPEAK", text: "I'm opening the booking page for you now. You'll be able to complete your reservation directly on the hotel's website. Is there anything else you'd like to explore?" })
          effects.push({ type: "OPEN_BOOKING_URL" })
          return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: state.unitSelected }, effects }

        case "BACK":
          effects.push({ type: "SPEAK", text: "Sure, let me show you the other available rooms." })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "HOTEL_EXPLORE":
        case "TRAVEL_TO_HOTEL":
          effects.push({ type: "SPEAK", text: "No problem, taking you back to the hotel overview." })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "OTHER_OPTIONS":
        case "ROOMS":
          effects.push({ type: "SPEAK", text: "Sure, let me show you the other available rooms." })
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
          effects.push({ type: "SPEAK", text: "Let me show you the surrounding area." })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "UNKNOWN":
          effects.push({ type: "SPEAK", text: UNKNOWN_RESPONSE })
          return { nextState: state, effects }

        default:
          return { nextState: state, effects: [] }
      }
    }

    if (action.type === "UNIT_SELECTED_UE5") {
      effects.push({
        type: "SPEAK",
        text: `Nice — the ${action.roomName}. Would you like to step inside or see the view from the exterior?`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice", unitSelected: true, lastProposal: "interior_or_exterior" }, effects }
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
          effects.push({ type: "SPEAK", text: "Back to the hotel. What would you like to explore next?" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "AFFIRMATIVE":
          // "Yes" after we suggested the next amenity → useJourney intercepts
          // and dispatches NAVIGATE_TO_AMENITY. If it reaches here, no suggestion active.
          if (state.suggestedNext) {
            // Safety: shouldn't normally reach here (useJourney intercepts), but handle gracefully
            effects.push({ type: "SPEAK", text: `Sure! Let me take you to the ${state.suggestedNext}. Just a moment.` })
            return { nextState: state, effects }
          }
          effects.push({ type: "SPEAK", text: "Would you like to see the rooms, or explore another area of the hotel?" })
          return { nextState: state, effects }

        case "NEGATIVE":
          if (state.suggestedNext) {
            // "No" to the suggested next amenity
            effects.push({ type: "SPEAK", text: "No worries. Would you like to check out the rooms, or see the surrounding area instead?" })
            return { nextState: { ...state, suggestedNext: undefined }, effects }
          }
          effects.push({ type: "SPEAK", text: "Shall we head back to the hotel overview?" })
          return { nextState: state, effects }

        case "BOOK":
          effects.push({ type: "SPEAK", text: "Great to hear you'd like to book! Let me show you the rooms first so you can pick your favorite." })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "ROOMS":
          effects.push({ type: "SPEAK", text: "Good call — let me show you the rooms." })
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
          effects.push({ type: "SPEAK", text: "Let me show you the surrounding area." })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "UNKNOWN":
          effects.push({ type: "SPEAK", text: UNKNOWN_RESPONSE })
          return { nextState: state, effects }

        default:
          return { nextState: state, effects: [] }
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
    effects.push({ type: "SPEAK", text: `Let me take you to the ${amenity.name} — ${narrative}${teaser}` })
    return { nextState, effects }
  }

  // -----------------------------------------------------------------------
  // LIST_AMENITIES — global handler, builds listing speech from action data
  // -----------------------------------------------------------------------
  if (action.type === "LIST_AMENITIES") {
    const { visitedAmenities, allAmenities, travelPurpose, recommendedAmenityName } = action
    const listing = buildAmenityListingSpeech(allAmenities, visitedAmenities, travelPurpose, recommendedAmenityName)
    effects.push({ type: "SPEAK", text: listing.text })

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
