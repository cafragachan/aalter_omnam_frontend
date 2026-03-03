// ---------------------------------------------------------------------------
// Journey State Machine — pure reducer, no React, fully testable
// ---------------------------------------------------------------------------

import type { JourneyState, JourneyAction, JourneyResult, JourneyEffect } from "./types"
import { getReengagePrompt } from "./reengage-prompts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAmenityNarrative(name: string, scene: string): string {
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
  profile: { partySize?: number; startDate?: Date | null; endDate?: Date | null },
): ProfileCollectionAwaiting {
  const missingDates = !profile.startDate || !profile.endDate
  const missingGuests = !profile.partySize

  if (missingDates && missingGuests) return "dates_and_guests"
  if (missingDates) return "dates"
  if (missingGuests) return "guests"
  // Interests are NO LONGER gating — they're collected during exploration
  return "ready"
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
    const prompt = getReengagePrompt(state)
    effects.push({ type: "SPEAK", text: prompt })
    return { nextState: state, effects }
  }

  // -----------------------------------------------------------------------
  // DOWNLOAD_DATA — admin command, works from any stage
  // -----------------------------------------------------------------------
  if (action.type === "USER_INTENT" && action.intent.type === "DOWNLOAD_DATA") {
    effects.push({ type: "DOWNLOAD_DATA" })
    return { nextState: state, effects }
  }

  // -----------------------------------------------------------------------
  // PROFILE_COLLECTION
  // -----------------------------------------------------------------------
  if (state.stage === "PROFILE_COLLECTION") {
    if (action.type === "PROFILE_UPDATED") {
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
              text: `Welcome ${firstName}! I'm Ava, your personal concierge. I'll guide you through our properties to find the perfect fit for you. Tell me about your trip — when are you planning to travel, and who's joining you?`,
            })
            break
          case "dates":
            effects.push({
              type: "SPEAK",
              text: `Great, thanks ${firstName}. Could you let me know when you're planning to travel — even a rough timeframe helps.`,
            })
            break
          case "guests":
            effects.push({
              type: "SPEAK",
              text: `And how many guests will be joining you? Adults, children — just so I can find the right fit.`,
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
    if (action.type === "HOTEL_PICKED") {
      const { hotelName, description } = action
      const narrative = `${description.charAt(0).toLowerCase()}${description.slice(1)}`

      effects.push({ type: "SET_JOURNEY_STAGE", stage: "HOTEL_EXPLORATION" })
      effects.push({ type: "UE5_COMMAND", command: "startTEST", value: "startTEST" })
      effects.push({
        type: "SPEAK",
        text: `Excellent choice — the ${hotelName} ${narrative}. Let me take you inside. You can explore available rooms, check out the amenities, or wander the surrounding area. What would you like to see first?`,
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
          effects.push({ type: "SPEAK", text: "Let me pull up the available rooms. I'll suggest the best fit based on your group size." })
          effects.push({ type: "OPEN_PANEL", panel: "rooms" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "AMENITIES":
          effects.push({ type: "SPEAK", text: "Great idea — let me show you what this property has to offer beyond the rooms." })
          effects.push({ type: "OPEN_PANEL", panel: "amenities" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "LOCATION":
          effects.push({ type: "SPEAK", text: "Let me show you the surrounding area. It's worth seeing what's nearby — there are some wonderful spots." })
          effects.push({ type: "OPEN_PANEL", panel: "location" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }

        case "BACK":
        case "HOTEL_EXPLORE":
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "SPEAK", text: "Back to the hotel overview. What would you like to explore next — rooms, amenities, or the area?" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "UNKNOWN":
          if (state.subState === "awaiting_intent") {
            effects.push({
              type: "SPEAK",
              text: "I'm here to help you explore. You can check out the rooms, see the amenities, or look at the surrounding area. What sounds good?",
            })
          }
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
        text: `The ${roomName} accommodates up to ${occupancy} guests. Select one of the highlighted units to see it up close.`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice" }, effects }
    }

    if (action.type === "UNIT_SELECTED_UE5") {
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({
        type: "SPEAK",
        text: `Great pick! The ${action.roomName} is a wonderful choice. Would you like to explore the interior or see the exterior view first?`,
      })
      return { nextState: { stage: "ROOM_SELECTED", awaiting: "view_choice" }, effects }
    }

    if (action.type === "AMENITY_CARD_TAPPED") {
      const narrative = buildAmenityNarrative(action.name, action.scene)
      effects.push({ type: "CLOSE_PANELS" })
      effects.push({ type: "UE5_COMMAND", command: "communal", value: action.amenityId })
      effects.push({ type: "FADE_TRANSITION" })
      effects.push({ type: "SPEAK", text: `Let me take you to the ${action.name} — ${narrative}` })
      return { nextState: { stage: "AMENITY_VIEWING" }, effects }
    }
  }

  // -----------------------------------------------------------------------
  // ROOM_SELECTED
  // -----------------------------------------------------------------------
  if (state.stage === "ROOM_SELECTED") {
    if (action.type === "USER_INTENT") {
      const { intent } = action

      switch (intent.type) {
        case "INTERIOR":
          effects.push({ type: "SPEAK", text: "Stepping inside — take a look around. Notice the natural light and the finishing details. What do you think?" })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "interior" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: state, effects }

        case "EXTERIOR":
          effects.push({ type: "SPEAK", text: "Here's the exterior view. The perspective from this floor is quite special." })
          effects.push({ type: "UE5_COMMAND", command: "unitView", value: "exterior" })
          return { nextState: state, effects }

        case "BACK":
          effects.push({ type: "SPEAK", text: "No problem, taking you back to the hotel overview." })
          effects.push({ type: "RESET_TO_DEFAULT" })
          effects.push({ type: "FADE_TRANSITION" })
          return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }

        case "UNKNOWN":
          effects.push({
            type: "SPEAK",
            text: "Would you like to see the interior, the view from outside, or go back to explore other options?",
          })
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
        effects.push({ type: "SPEAK", text: "Back to the hotel. What would you like to explore next?" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "awaiting_intent" }, effects }
      }

      if (intent.type === "ROOMS") {
        effects.push({ type: "SPEAK", text: "Good call — let me show you the rooms." })
        effects.push({ type: "OPEN_PANEL", panel: "rooms" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
      }
      if (intent.type === "AMENITIES") {
        effects.push({ type: "SPEAK", text: "Let me show you what else is available." })
        effects.push({ type: "OPEN_PANEL", panel: "amenities" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
      }
      if (intent.type === "LOCATION") {
        effects.push({ type: "SPEAK", text: "Let me show you the surrounding area." })
        effects.push({ type: "OPEN_PANEL", panel: "location" })
        return { nextState: { stage: "HOTEL_EXPLORATION", subState: "panel_open" }, effects }
      }
    }
  }

  // -----------------------------------------------------------------------
  // ROOM_BOOKING
  // -----------------------------------------------------------------------
  if (state.stage === "ROOM_BOOKING") {
    if (action.type === "BOOKING_CONFIRMED") {
      effects.push({
        type: "SPEAK",
        text: "Wonderful — your booking is confirmed! You'll receive a confirmation email shortly. I hope you have an amazing stay. Is there anything else I can help with?",
      })
      return { nextState: { stage: "ROOM_BOOKING", subState: "confirmed" }, effects }
    }

    if (action.type === "BOOKING_SAVED") {
      effects.push({
        type: "SPEAK",
        text: "No problem — I've saved your selection. You can come back anytime to finalize. Is there anything else you'd like to explore?",
      })
      return { nextState: { stage: "ROOM_BOOKING", subState: "confirmed" }, effects }
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
