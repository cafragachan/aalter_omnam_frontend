// ---------------------------------------------------------------------------
// Journey State Machine — pure reducer, no React, fully testable
// ---------------------------------------------------------------------------

import type { JourneyState, JourneyAction, JourneyResult, JourneyEffect } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAmenityNarrative(name: string, scene: string): string {
  const n = name.toLowerCase()
  const s = scene.toLowerCase()
  if (s.includes("lobby") || n.includes("lobby")) {
    return "we'll step into a grand, light-filled arrival lounge with plush seating and a calm lakeside energy."
  }
  if (s.includes("conference") || n.includes("conference")) {
    return "this conference space is set up for focused meetings with modern tech, warm lighting, and quiet service."
  }
  return "it's one of the property's signature spaces, designed for comfort, flow, and a touch of quiet luxury."
}

type ProfileCollectionAwaiting = Extract<JourneyState, { stage: "PROFILE_COLLECTION" }>["awaiting"]

function profileCollectionAwaiting(
  profile: { partySize?: number; startDate?: Date | null; endDate?: Date | null; interests: string[] },
): ProfileCollectionAwaiting {
  const missingDates = !profile.startDate || !profile.endDate
  const missingGuests = !profile.partySize
  const missingInterests = profile.interests.length === 0

  if (missingDates && missingGuests) return "dates_and_guests"
  if (missingDates) return "dates"
  if (missingGuests) return "guests"
  if (missingInterests) return "interests"
  return "ready"
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyResult {
  const effects: JourneyEffect[] = []

  // -----------------------------------------------------------------------
  // PROFILE_COLLECTION
  // -----------------------------------------------------------------------
  if (state.stage === "PROFILE_COLLECTION") {
    if (action.type === "PROFILE_UPDATED") {
      // If extraction is still running, wait
      if (action.isExtractionPending) {
        return { nextState: { stage: "PROFILE_COLLECTION", awaiting: "extracting" }, effects: [] }
      }

      const awaiting = profileCollectionAwaiting(action.profile)
      const firstName = action.firstName?.trim() || "there"

      // Profile is complete → advance to destination selection
      if (awaiting === "ready") {
        effects.push({ type: "SET_JOURNEY_STAGE", stage: "DESTINATION_SELECT" })
        return { nextState: { stage: "DESTINATION_SELECT" }, effects }
      }

      // Still missing data — only prompt if the awaiting state changed
      if (state.awaiting !== awaiting) {
        switch (awaiting) {
          case "dates_and_guests":
            effects.push({
              type: "SPEAK",
              text: `${firstName}, to find the perfect property for you, I need to know: when are you planning to travel and how many guests will be joining you?`,
            })
            break
          case "dates":
            effects.push({
              type: "SPEAK",
              text: `${firstName}, could you please confirm: when are you planning to travel?`,
            })
            break
          case "guests":
            effects.push({
              type: "SPEAK",
              text: `${firstName}, I'd also need to know: how many guests will be joining you?`,
            })
            break
          case "interests":
            effects.push({
              type: "SPEAK",
              text: `Perfect! Now tell me, what kind of experiences are you looking for?`,
            })
            break
        }
        return { nextState: { stage: "PROFILE_COLLECTION", awaiting }, effects }
      }

      return { nextState: state, effects: [] }
    }
  }

  // -----------------------------------------------------------------------
  // DESTINATION_SELECT
  // -----------------------------------------------------------------------
  if (state.stage === "DESTINATION_SELECT") {
    // Entry announcement is handled once when stage is first set
    if (action.type === "HOTEL_PICKED") {
      const { hotelName, description } = action
      const narrative = `${description.charAt(0).toLowerCase()}${description.slice(1)}`

      effects.push({ type: "SET_JOURNEY_STAGE", stage: "HOTEL_EXPLORATION" })
      effects.push({ type: "UE5_COMMAND", command: "startTEST", value: "startTEST" })
      effects.push({
        type: "SPEAK",
        text: `Great choice—the ${hotelName} is a fantastic hotel that ${narrative}. Would you like to explore available rooms, check out the hotel amenities, or get a feel for the surrounding area?`,
      })

      return {
        nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" },
        effects,
      }
    }
  }

  // -----------------------------------------------------------------------
  // HOTEL_EXPLORATION
  // -----------------------------------------------------------------------
  if (state.stage === "HOTEL_EXPLORATION") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      switch (intent.type) {
        case "ROOMS":
          effects.push({ type: "SPEAK", text: "Perfect, I'll pull up the available rooms for you now." })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "AMENITIES":
          effects.push({ type: "SPEAK", text: "Of course. Let me show you the amenities available at this property." })
          effects.push({ type: "OPEN_PANEL", panel: "amenities" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "LOCATION":
          effects.push({ type: "SPEAK", text: "Absolutely. I'll show you the surrounding area and location context." })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "BACK":
        case "HOTEL_EXPLORE":
          effects.push({ type: "RESET_TO_DEFAULT" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "UNKNOWN":
          if (state.subState === "awaiting_intent") {
            effects.push({
              type: "SPEAK",
              text: "Got it. Would you like to explore rooms, check out the hotel amenities, or see the surrounding area?",
            })
          }
          return { nextState: state, effects }

        default:
          return { nextState: state, effects: [] }
      }
    }

    // Room card tapped from UI
    if (action.type === "ROOM_CARD_TAPPED") {
      const { roomName, occupancy, roomId } = action
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "UE5_COMMAND", command: "selectedRoom", value: roomId })
      effects.push({
        type: "SPEAK",
        text: `The ${roomName} can host up to ${occupancy} guests. Please select one of our available rooms at the highlighted locations`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice" }, effects }
    }

    // Unit selected from UE5
    if (action.type === "UNIT_SELECTED_UE5") {
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({
        type: "SPEAK",
        text: `Lovely pick! The ${action.roomName} is an excellent choice. Would you like to explore the interior or the exterior view of this room?`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice" }, effects }
    }

    // Amenity card tapped from UI
    if (action.type === "AMENITY_CARD_TAPPED") {
      const narrative = buildAmenityNarrative(action.name, action.scene)
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "UE5_COMMAND", command: "communal", value: action.amenityId })
      effects.push({ type: "FADE_TRANSITION" })
      effects.push({ type: "SPEAK", text: `Perfect, let me take you to the ${action.name}, ${narrative}` })
      return { nextState: { stage: "AMENITY_VIEWING" }, effects }
    }
  }

  // -----------------------------------------------------------------------
  // ROOM_SELECTED — waiting for interior / exterior / back
  // -----------------------------------------------------------------------
  if (state.stage === "ROOM_SELECTED") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      switch (intent.type) {
        case "INTERIOR":
          effects.push({ type: "SPEAK", text: "Ok, Let me show you the interior of this room." })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "interior" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: state, effects }

        case "EXTERIOR":
          effects.push({ type: "SPEAK", text: "Perfect! Here's the exterior view of this room." })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "exterior" })
          return { nextState: state, effects }

        case "BACK":
          effects.push({ type: "SPEAK", text: "No problem, taking you back to the hotel view." })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "UNKNOWN":
          effects.push({
            type: "SPEAK",
            text: "I didn't catch that. Would you like to explore the room interior, the exterior view, or go back?",
          })
          return { nextState: state, effects }

        default:
          return { nextState: state, effects: [] }
      }
    }

    // Another unit selected from UE5 while already in room view
    if (action.type === "UNIT_SELECTED_UE5") {
      effects.push({
        type: "SPEAK",
        text: `Lovely pick! The ${action.roomName} is an excellent choice. Would you like to explore the interior or the exterior view of this room?`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice" }, effects }
    }
  }

  // -----------------------------------------------------------------------
  // AMENITY_VIEWING
  // -----------------------------------------------------------------------
  if (state.stage === "AMENITY_VIEWING") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      if (intent.type === "BACK" || intent.type === "HOTEL_EXPLORE") {
        effects.push({ type: "RESET_TO_DEFAULT" })
        effects.push({ type: "FADE_TRANSITION" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
      }

      // Allow navigating to rooms/amenities/location from amenity view
      if (intent.type === "ROOMS") {
        effects.push({ type: "SPEAK", text: "Loading the available rooms for you now." })
        effects.push({ type: "OPEN_PANEL", panel: "rooms" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
      }
      if (intent.type === "AMENITIES") {
        effects.push({ type: "SPEAK", text: "Sure, opening the amenities for this property." })
        effects.push({ type: "OPEN_PANEL", panel: "amenities" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
      }
      if (intent.type === "LOCATION") {
        effects.push({ type: "SPEAK", text: "Taking you to the surrounding area and location view." })
        effects.push({ type: "OPEN_PANEL", panel: "location" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
      }
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
