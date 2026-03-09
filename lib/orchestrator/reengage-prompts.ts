import type { JourneyState } from "./types"

// ---------------------------------------------------------------------------
// Contextual re-engagement prompts — triggered after idle timeout
// ---------------------------------------------------------------------------
// Each prompt is tailored to the current journey state so it feels natural
// rather than a generic "are you still there?" nudge.
// ---------------------------------------------------------------------------

const PROFILE_COLLECTION_PROMPTS = [
  "Take your time! Do you have approximate dates in mind, or are you flexible?",
  "No rush — just let me know when you're traveling and how many guests, and I'll find the best options for you.",
  "If you're not sure of exact dates yet, a rough timeframe works too — spring, summer, a specific month?",
]

const DESTINATION_SELECT_PROMPTS = [
  "Take your time browsing. The EDITION Lake Como is our most popular property right now — shall I tell you more about it?",
  "Each property has a unique character. Would you like me to highlight what makes each one special?",
  "If you're drawn to any of these, just tap the card and I'll take you inside for a virtual tour.",
]

const VIRTUAL_LOUNGE_ASKING_PROMPTS = [
  "Would you like to explore the lounge, or shall we head straight to the hotel?",
  "Take your time — the lounge has some beautiful pieces. Or we can go directly to the hotel if you prefer.",
  "The gallery is worth a look, but no pressure. Ready to travel to the hotel?",
]

const VIRTUAL_LOUNGE_EXPLORING_PROMPTS = [
  "Take your time browsing. When you're ready to visit the hotel, just let me know.",
  "Beautiful space, isn't it? Whenever you'd like to head to the hotel, just say the word.",
  "Would you like to head to the hotel now, or keep exploring the lounge?",
]

const HOTEL_EXPLORATION_AWAITING_PROMPTS = [
  "Would you like to explore the rooms, check out the amenities, or get a feel for the surrounding area?",
  "I can show you the available room types, or if you'd prefer, we can start with the hotel amenities. What sounds good?",
  "There's a lot to see here. Shall I walk you through the rooms first, or would you like to explore the facilities?",
]

const HOTEL_EXPLORATION_PANEL_PROMPTS = [
  "I see you're browsing the options. Would you like me to recommend something based on what I know about your trip?",
  "Any of these catch your eye? I'm happy to share more details on any of them.",
  "Take your time looking — and let me know if you have any questions about what you see.",
]

const AMENITY_VIEWING_PROMPTS = [
  "This space is lovely, isn't it? Would you like to explore another area, or shall we look at rooms?",
  "Is there anything specific you'd like to know about this space? Or shall we continue the tour?",
  "I can also show you how this area looks at different times of day. Or we can move on to the rooms — up to you.",
]

const ROOM_SELECTED_PROMPTS = [
  "Would you like to see the room from a different angle, or shall I tell you more about what's included?",
  "This room has some wonderful details. Would you like to explore the interior, or see the view from outside?",
  "If you'd like, I can also show you similar rooms on different floors. Or we can proceed with this one.",
]

/**
 * Get a contextual re-engagement prompt based on current journey state.
 * Returns a different prompt each time to avoid repetition.
 */
let promptIndex = 0

export function getReengagePrompt(state: JourneyState): string {
  promptIndex++

  const pick = (prompts: string[]) => prompts[promptIndex % prompts.length]

  switch (state.stage) {
    case "PROFILE_COLLECTION":
      return pick(PROFILE_COLLECTION_PROMPTS)
    case "DESTINATION_SELECT":
      return pick(DESTINATION_SELECT_PROMPTS)
    case "VIRTUAL_LOUNGE":
      if (state.subState === "exploring") return pick(VIRTUAL_LOUNGE_EXPLORING_PROMPTS)
      return pick(VIRTUAL_LOUNGE_ASKING_PROMPTS)
    case "HOTEL_EXPLORATION":
      if (state.subState === "panel_open") return pick(HOTEL_EXPLORATION_PANEL_PROMPTS)
      return pick(HOTEL_EXPLORATION_AWAITING_PROMPTS)
    case "AMENITY_VIEWING":
      return pick(AMENITY_VIEWING_PROMPTS)
    case "ROOM_SELECTED":
      return pick(ROOM_SELECTED_PROMPTS)
  }
}
