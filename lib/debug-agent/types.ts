import type { UserProfile } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import { rooms as HOTEL_ROOMS } from "@/lib/hotel-data"
import {
  createAvaSession,
  decideNextAction,
  type AvaDecision,
  type AvaSession,
  type FactsUpdate,
  type MissingFact,
  type SharingPreference,
} from "@/lib/agent-experience/checkpoints"

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

export type DebugGateId =
  | "travel_dates"
  | "party_composition"
  | "children_ages"
  | "selected_room_plan"
  | "accessibility"
  | "final_confirmation"

export type DebugGateStatus = "missing" | "ready" | "not_required" | "waiting"

export type DebugGate = {
  id: DebugGateId
  label: string
  required: boolean
  status: DebugGateStatus
  value?: string
  source?: "profile" | "room_plan" | "flow" | "policy"
  reason?: string
}

export type DebugBookingGate = {
  session: AvaSession
  decision: AvaDecision
  gates: DebugGate[]
  missing: MissingFact[]
}

const GATES: Array<Pick<DebugGate, "id" | "label" | "required">> = [
  { id: "travel_dates", label: "Travel dates", required: true },
  { id: "party_composition", label: "Party composition", required: true },
  { id: "children_ages", label: "Children ages", required: true },
  { id: "selected_room_plan", label: "Selected room plan", required: true },
  { id: "accessibility", label: "Accessibility", required: false },
  { id: "final_confirmation", label: "Final confirmation", required: true },
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

function sharingFromDistribution(value: UserProfile["distributionPreference"]): SharingPreference | undefined {
  if (value === "together" || value === "separate") return value
  if (value === "auto") return "unknown"
  return undefined
}

function roomPlanSummary(roomPlan: CurrentRoomPlan): string {
  return roomPlan.rooms
    .map((entry) => {
      const room = HOTEL_ROOMS.find((candidate) => candidate.id === entry.roomId)
      return `${entry.quantity}x ${room?.name ?? entry.roomId}`
    })
    .join(", ")
}

export function factsFromDebugState(profile: UserProfile, roomPlan: CurrentRoomPlan | null): FactsUpdate {
  const start = formatProfileDate(profile.startDate)
  const end = formatProfileDate(profile.endDate)
  const children = profile.guestComposition?.children
  const accessibilityNeeds = profile.accessibilityNeeds?.filter(Boolean) ?? []
  const roomCount = profile.roomAllocation?.length || roomPlan?.rooms.reduce((sum, entry) => sum + entry.quantity, 0)

  return {
    destination: profile.destination ?? "EDITION Lake Como",
    dates: {
      arrival: start ?? null,
      departure: end ?? null,
    },
    party: {
      adults: typeof profile.guestComposition?.adults === "number" ? profile.guestComposition.adults : null,
      children: typeof children === "number" ? children : null,
      childrenAges: profile.guestComposition?.childrenAges ?? null,
    },
    roomIntent: {
      roomCount: roomCount || null,
      roomType: profile.roomTypePreference ?? null,
      sharing: sharingFromDistribution(profile.distributionPreference) ?? null,
      notes: profile.roomAllocation?.length ? profile.roomAllocation.map((guests, index) => `Room ${index + 1}: ${guests} guest${guests === 1 ? "" : "s"}`) : null,
    },
    accessibility: {
      status: accessibilityNeeds.length ? "has_needs" : "unknown",
      notes: accessibilityNeeds.length ? accessibilityNeeds.join(", ") : null,
    },
    selectedPlan: roomPlan
      ? {
          summary: roomPlanSummary(roomPlan),
          roomCount: roomPlan.rooms.reduce((sum, entry) => sum + entry.quantity, 0),
          source: "room_plan",
        }
      : null,
    account: {
      name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null,
      email: profile.email ?? null,
      phone: profile.phoneNumber ?? null,
    },
  }
}

export function deriveDebugBookingGate(profile: UserProfile, roomPlan: CurrentRoomPlan | null): DebugBookingGate {
  const session = createAvaSession({ facts: factsFromDebugState(profile, roomPlan) })
  const decision = decideNextAction(session)
  const missing = decision.readiness.canPrepareBooking.missing ?? []
  const missingIds = new Set(missing.map((item) => item.id))
  const children = decision.facts.party.children?.value ?? 0
  const gates = GATES.map((base): DebugGate => {
    if (base.id === "travel_dates") {
      const arrival = decision.facts.dates.arrival?.value
      const departure = decision.facts.dates.departure?.value
      return {
        ...base,
        status: missingIds.has("travel_dates") || missingIds.has("arrival_date") || missingIds.has("departure_date") ? "missing" : "ready",
        value: [arrival, departure].filter(Boolean).join(" to ") || undefined,
        source: arrival || departure ? "profile" : undefined,
        reason: missing.find((item) => item.id === "travel_dates" || item.id === "arrival_date" || item.id === "departure_date")?.reason,
      }
    }

    if (base.id === "party_composition") {
      const adults = decision.facts.party.adults?.value
      const childCount = decision.facts.party.children?.value ?? 0
      return {
        ...base,
        status: missingIds.has("guest_party") || missingIds.has("adult_count") ? "missing" : "ready",
        value: typeof adults === "number" ? `${adults} adult${adults === 1 ? "" : "s"}, ${childCount} child${childCount === 1 ? "" : "ren"}` : undefined,
        source: typeof adults === "number" ? "profile" : undefined,
        reason: missing.find((item) => item.id === "guest_party" || item.id === "adult_count")?.reason,
      }
    }

    if (base.id === "children_ages") {
      if (children <= 0) return { ...base, status: "not_required", value: "No children in party", source: "profile" }
      const ages = decision.facts.party.childrenAges?.value ?? []
      return {
        ...base,
        status: missingIds.has("children_ages") ? "missing" : "ready",
        value: ages.length ? ages.join(", ") : undefined,
        source: ages.length ? "profile" : undefined,
        reason: missing.find((item) => item.id === "children_ages")?.reason,
      }
    }

    if (base.id === "selected_room_plan") {
      return {
        ...base,
        status: missingIds.has("room_plan") ? "missing" : "ready",
        value: decision.facts.selectedPlan?.summary,
        source: decision.facts.selectedPlan ? "room_plan" : undefined,
        reason: missing.find((item) => item.id === "room_plan")?.reason,
      }
    }

    if (base.id === "accessibility") {
      const required = decision.policy.accessibilityMode !== "optional"
      const status = decision.facts.accessibility.status
      return {
        ...base,
        required,
        status: required && missingIds.has("accessibility") ? "missing" : status === "unknown" ? "not_required" : "ready",
        value: status === "has_needs" ? decision.facts.accessibility.notes?.value : status === "none" ? "None" : "Optional by policy",
        source: status === "unknown" ? "policy" : "profile",
        reason: missing.find((item) => item.id === "accessibility")?.reason,
      }
    }

    return {
      ...base,
      status: decision.flow.state === "awaiting_final_confirmation" ? "waiting" : decision.flow.state === "booking_opened" ? "ready" : "missing",
      value: decision.flow.pendingFinalRecap?.planHash ?? decision.flow.openedTurnId,
      source: "flow",
      reason: decision.readiness.canOpenBooking.reason,
    }
  })

  return { session, decision, gates, missing }
}

export function deriveCheckpoints(
  profile: UserProfile,
  _messages: DebugTranscriptMessage[],
  _events: DebugEvent[],
): DebugGate[] {
  return deriveDebugBookingGate(profile, null).gates
}
