import type { UserProfile } from "@/lib/context"

export type DebugEventType =
  | "session_started"
  | "transcript_user"
  | "transcript_ava"
  | "tool_called"
  | "profile_updated"
  | "checkpoint_collected"
  | "checkpoint_missing"
  | "session_completed"
  | "session_failed"

export type DebugEvent = {
  id: string
  type: DebugEventType
  timestamp: number
  label: string
  detail?: string
  payload?: unknown
}

export type DebugTranscriptMessage = {
  sender: "user" | "ava"
  message: string
  timestamp: number
}

export type CheckpointId =
  | "travel_dates"
  | "party_composition"
  | "children_ages"
  | "room_composition"
  | "trip_purpose"
  | "interests"
  | "budget"
  | "dietary_needs"
  | "accessibility_needs"

export type CheckpointStatus = "missing" | "collected" | "not_applicable"

export type DebugCheckpoint = {
  id: CheckpointId
  label: string
  required: boolean
  status: CheckpointStatus
  value?: string
  source?: "profile" | "transcript"
  collectedAt?: number
  turnIndex?: number
}

const CHECKPOINTS: Array<Pick<DebugCheckpoint, "id" | "label" | "required">> = [
  { id: "travel_dates", label: "Travel dates", required: true },
  { id: "party_composition", label: "Party composition", required: true },
  { id: "children_ages", label: "Children ages", required: true },
  { id: "room_composition", label: "Room composition", required: true },
  { id: "trip_purpose", label: "Trip purpose", required: true },
  { id: "interests", label: "Interests", required: false },
  { id: "budget", label: "Budget", required: false },
  { id: "dietary_needs", label: "Dietary needs", required: false },
  { id: "accessibility_needs", label: "Accessibility needs", required: false },
]

export function makeDebugEvent(
  type: DebugEventType,
  label: string,
  detail?: string,
  payload?: unknown,
): DebugEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: Date.now(),
    label,
    detail,
    payload,
  }
}

export function formatProfileDate(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString().slice(0, 10)
}

function firstTurnMatching(
  messages: DebugTranscriptMessage[],
  re: RegExp,
): { timestamp: number; turnIndex: number; text: string } | undefined {
  const userMessages = messages.filter((m) => m.sender === "user")
  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i]
    if (re.test(msg.message)) return { timestamp: msg.timestamp, turnIndex: i + 1, text: msg.message }
  }
  return undefined
}

function profileCollectionTime(
  events: DebugEvent[],
  fieldNames: string[],
): number | undefined {
  for (const event of events) {
    if (event.type !== "profile_updated") continue
    const payload = event.payload as Record<string, unknown> | undefined
    if (!payload) continue
    if (fieldNames.some((name) => payload[name] != null)) return event.timestamp
  }
  return undefined
}

function collected(
  base: Pick<DebugCheckpoint, "id" | "label" | "required">,
  value: string,
  source: "profile" | "transcript",
  collectedAt?: number,
  turnIndex?: number,
): DebugCheckpoint {
  return {
    ...base,
    status: "collected",
    value,
    source,
    collectedAt,
    turnIndex,
  }
}

export function deriveCheckpoints(
  profile: UserProfile,
  messages: DebugTranscriptMessage[],
  events: DebugEvent[],
): DebugCheckpoint[] {
  return CHECKPOINTS.map((base): DebugCheckpoint => {
    if (base.id === "travel_dates") {
      const start = formatProfileDate(profile.startDate)
      const end = formatProfileDate(profile.endDate)
      if (start || end) {
        return collected(base, [start, end].filter(Boolean).join(" to "), "profile", profileCollectionTime(events, ["startDate", "endDate"]))
      }
    }

    if (base.id === "party_composition") {
      const gc = profile.guestComposition
      if (gc && (typeof gc.adults === "number" || typeof gc.children === "number")) {
        const adults = gc.adults ?? 0
        const children = gc.children ?? 0
        return collected(base, `${adults} adult${adults === 1 ? "" : "s"}, ${children} child${children === 1 ? "" : "ren"}`, "profile", profileCollectionTime(events, ["guestComposition"]))
      }
    }

    if (base.id === "children_ages") {
      if (!profile.guestComposition || typeof profile.guestComposition.children !== "number") {
        return { ...base, status: "missing" }
      }
      const children = profile.guestComposition.children
      if (children <= 0) return { ...base, status: "not_applicable", value: "No children in party" }
      const ages = profile.guestComposition?.childrenAges
      if (ages && ages.length >= children) {
        return collected(base, ages.join(", "), "profile", profileCollectionTime(events, ["guestComposition"]))
      }
    }

    if (base.id === "room_composition") {
      const match = firstTurnMatching(messages, /\b(together|separate|connecting|adjoining|same room|one room|two rooms|2 rooms|three rooms|3 rooms|per room|kids.*room|children.*room)\b/i)
      if (match) return collected(base, match.text, "transcript", match.timestamp, match.turnIndex)
      if (profile.distributionPreference) {
        return collected(base, profile.distributionPreference, "profile", profileCollectionTime(events, ["distributionPreference", "roomAllocation"]))
      }
    }

    if (base.id === "trip_purpose") {
      if (profile.travelPurpose) {
        return collected(base, profile.travelPurpose, "profile", profileCollectionTime(events, ["travelPurpose"]))
      }
    }

    if (base.id === "interests" && profile.interests.length) {
      return collected(base, profile.interests.join(", "), "profile", profileCollectionTime(events, ["interests"]))
    }

    if (base.id === "budget" && profile.budgetRange) {
      return collected(base, profile.budgetRange, "profile", profileCollectionTime(events, ["budgetRange"]))
    }

    if (base.id === "dietary_needs" && profile.dietaryRestrictions?.length) {
      return collected(base, profile.dietaryRestrictions.join(", "), "profile", profileCollectionTime(events, ["dietaryRestrictions"]))
    }

    if (base.id === "accessibility_needs" && profile.accessibilityNeeds?.length) {
      return collected(base, profile.accessibilityNeeds.join(", "), "profile", profileCollectionTime(events, ["accessibilityNeeds"]))
    }

    return { ...base, status: "missing" }
  })
}
