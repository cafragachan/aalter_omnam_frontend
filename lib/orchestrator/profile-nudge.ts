// ---------------------------------------------------------------------------
// Profile Nudge — sends conversational prompts via message() to steer HeyGen
// back on track during PROFILE_COLLECTION when it forgets missing fields.
//
// These are sent as LLM input (not TTS), so HeyGen's AI decides how to
// naturally incorporate the redirect into its next response.
// ---------------------------------------------------------------------------

import type { AvatarDerivedProfile } from "@/lib/liveavatar/useUserProfile"

type ProfileCollectionAwaiting =
  | "dates_and_guests"
  | "dates"
  | "guests"
  | "guest_breakdown"
  | "travel_purpose"
  | "bed_distribution"
  | "interests"
  | "extracting"
  | "ready"

// ---------------------------------------------------------------------------
// Conversational redirect phrases per missing field
// ---------------------------------------------------------------------------

const GENTLE_REDIRECTS: Record<string, string[]> = {
  dates_and_guests: [
    "Oh, I don't think I caught when you're planning to visit or how many will be joining. When were you thinking of traveling?",
    "Before we go further — when are you thinking of coming to Lake Como, and who will be with you?",
  ],
  dates: [
    "Oh, I don't think I caught the dates yet — when were you thinking of visiting?",
    "By the way, do you have specific dates in mind for the trip?",
  ],
  guests: [
    "And how many of you will be traveling? Just so I can find the perfect setup.",
    "I want to make sure I have the right rooms in mind — how many guests will there be?",
  ],
  guest_breakdown: [
    "And of your group, how many are adults and how many are children? It helps me with the room setup.",
    "Just to get the rooms right — are any of your group children, or all adults?",
  ],
  travel_purpose: [
    "Lovely. And what's the occasion — a getaway, business, or celebrating something special?",
    "Is this more of a leisure trip, or are you traveling for a particular reason?",
  ],
  bed_distribution: [
    "For your group, would you prefer to share rooms or have separate rooms? Or I can recommend the best layout.",
    "One more thing — would you like everyone together, or would separate rooms work better?",
  ],
}

const FIRM_REDIRECTS: Record<string, string[]> = {
  dates_and_guests: [
    "I still need your travel dates and group size to get things set up. When are you coming, and how many will there be?",
  ],
  dates: [
    "I still need your travel dates to get things set up properly. When are you planning to arrive and depart?",
  ],
  guests: [
    "I still need to know how many guests will be joining. Could you let me know your group size?",
  ],
  guest_breakdown: [
    "I need to know the adult and children split to recommend the right rooms. How many adults and how many children?",
  ],
  travel_purpose: [
    "To personalize your experience, I need to know the purpose of your trip. Is it leisure, business, a celebration?",
  ],
  bed_distribution: [
    "Last thing before we head to the hotel — would you like shared rooms, separate rooms, or shall I recommend?",
  ],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a conversational nudge prompt for HeyGen when it's lingering
 * without collecting a required field.
 *
 * @param awaiting   - the current `awaiting` value from the journey state
 * @param _profile   - the merged derived profile (reserved for future use)
 * @param nudgeCount - how many nudges we've sent for this same `awaiting` value (0-based)
 * @returns the nudge string to send via message(), or null if no nudge needed
 */
export function buildProfileNudge(
  awaiting: ProfileCollectionAwaiting,
  _profile: AvatarDerivedProfile,
  nudgeCount: number,
): string | null {
  if (awaiting === "ready" || awaiting === "extracting") return null

  // Pick from the appropriate escalation level
  if (nudgeCount <= 1) {
    const options = GENTLE_REDIRECTS[awaiting]
    if (!options) return null
    return options[nudgeCount % options.length]
  }

  const options = FIRM_REDIRECTS[awaiting]
  if (!options) return null
  return options[0]
}
