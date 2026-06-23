/**
 * First-principles Ava booking gate.
 *
 * This module intentionally does not interpret natural language. It consumes
 * structured conversation understanding from an upstream LLM/NLU layer, merges
 * facts into session state, and returns the next deterministic action.
 */

export type FactSource = "profile" | "identity" | "understanding" | "room_plan" | "flow"

export type Fact<T> = {
  value: T
  source: FactSource
  confidence?: number
  evidenceTurnId?: string
}

export type GuestRelation = "solo" | "couple" | "family" | "friends" | "colleagues" | "group" | "unknown"
export type ViewPreference = "lake" | "mountain" | "any" | "unknown"
export type SharingPreference = "together" | "separate" | "mixed" | "unknown"
export type AccessibilityStatus = "unknown" | "none" | "has_needs"

export type StayDates = {
  arrival?: Fact<string>
  departure?: Fact<string>
}

export type GuestParty = {
  adults?: Fact<number>
  children?: Fact<number>
  childrenAges?: Fact<number[]>
  relation?: Fact<GuestRelation>
}

export type RoomIntent = {
  roomCount?: Fact<number>
  roomType?: Fact<string>
  view?: Fact<ViewPreference>
  sharing?: Fact<SharingPreference>
  proximity?: Fact<"same_level" | "close_together" | "any">
  notes?: Fact<string[]>
}

export type AccessibilityFacts = {
  status: AccessibilityStatus
  notes?: Fact<string>
}

export type SelectedRoomPlan = {
  id?: string
  summary?: string
  roomCount?: number
  roomType?: string
  view?: ViewPreference
  planHash?: string
  source?: "room_plan" | "understanding" | "flow"
}

export type AccountFacts = {
  name?: Fact<string>
  email?: Fact<string>
  phone?: Fact<string>
}

export type StayFacts = {
  destination?: Fact<string>
  dates: StayDates
  party: GuestParty
  roomIntent: RoomIntent
  accessibility: AccessibilityFacts
  selectedPlan?: SelectedRoomPlan
  account: AccountFacts
}

export type FactsUpdate = {
  destination?: string | null
  dates?: {
    arrival?: string | null
    departure?: string | null
  }
  party?: {
    adults?: number | null
    children?: number | null
    childrenAges?: number[] | null
    relation?: GuestRelation | null
  }
  roomIntent?: {
    roomCount?: number | null
    roomType?: string | null
    view?: ViewPreference | null
    sharing?: SharingPreference | null
    proximity?: "same_level" | "close_together" | "any" | null
    notes?: string[] | null
  }
  accessibility?: {
    status?: AccessibilityStatus | null
    notes?: string | null
  }
  selectedPlan?: SelectedRoomPlan | null
  account?: {
    name?: string | null
    email?: string | null
    phone?: string | null
  }
}

export type ConversationIntent =
  | "provide_info"
  | "revise_plan"
  | "request_room_plan"
  | "request_booking"
  | "confirm_pending_booking"
  | "reject_pending_booking"
  | "ask_question"
  | "continue_experience"
  | "unknown"

export type ConfirmationSignal = {
  kind: "affirm" | "deny" | "revise" | "unclear"
  confidence: number
  targetPlanHash?: string
}

export type ConversationUnderstanding = {
  turnId: string
  actor: "guest"
  intent: ConversationIntent
  facts?: FactsUpdate
  confirmation?: ConfirmationSignal
}

export type AccessibilityMode = "optional" | "ask_before_booking" | "required"

export type BookingPolicy = {
  accessibilityMode: AccessibilityMode
  minimumConfirmationConfidence: number
}

export const DEFAULT_BOOKING_POLICY: BookingPolicy = {
  accessibilityMode: "optional",
  minimumConfirmationConfidence: 0.75,
}

export type BookingFlowState =
  | "exploring"
  | "booking_preflight"
  | "awaiting_final_confirmation"
  | "booking_opening"
  | "booking_opened"

export type PendingFinalRecap = {
  assistantTurnId: string
  planHash: string
  presentedAt?: number
}

export type BookingFlow = {
  state: BookingFlowState
  pendingFinalRecap?: PendingFinalRecap
  consumedConfirmationTurnIds: string[]
  opening?: {
    confirmationTurnId: string
    planHash: string
  }
  openedTurnId?: string
}

export type AvaSession = {
  facts: StayFacts
  flow: BookingFlow
  policy: BookingPolicy
  appliedTurnIds: string[]
}

export type MissingFactId =
  | "travel_dates"
  | "arrival_date"
  | "departure_date"
  | "guest_party"
  | "adult_count"
  | "children_ages"
  | "room_plan"
  | "accessibility"
  | "guest_name"
  | "guest_email"
  | "guest_phone"

export type MissingFact = {
  id: MissingFactId
  owner: "chat" | "auth_or_ui" | "upstream"
  label: string
  reason: string
}

export type GuardResult = {
  allowed: boolean
  reason: string
  missing?: MissingFact[]
  requiredState?: BookingFlowState
}

export type AvaReadiness = {
  canRecommendRooms: GuardResult
  canPrepareBooking: GuardResult
  canOpenBooking: GuardResult
}

export type AvaActionType =
  | "ASK_MISSING_FACT"
  | "PROPOSE_ROOM_PLAN"
  | "PRESENT_FINAL_RECAP"
  | "OPEN_BOOKING"
  | "REVISE_ROOM_PLAN"
  | "TRAVEL_TO_HOTEL"
  | "ANSWER_OR_CONTINUE"
  | "WAIT_FOR_GUEST"
  | "DO_NOT_REPEAT_FINAL_RECAP"

export type AvaNextAction = {
  type: AvaActionType
  reason: string
  missing?: MissingFact
  tool?: "propose_room_plan" | "open_booking" | "travel_to_hotel"
  planHash?: string
  confirmationTurnId?: string
}

export type AvaDecision = {
  facts: StayFacts
  flow: BookingFlow
  policy: BookingPolicy
  readiness: AvaReadiness
  nextAction: AvaNextAction
  debug: {
    planHash?: string
    latestTurnId?: string
    missingForBooking: MissingFact[]
  }
}

export const DEFAULT_STAY_FACTS: StayFacts = {
  dates: {},
  party: {},
  roomIntent: {},
  accessibility: { status: "unknown" },
  account: {},
}

export const DEFAULT_BOOKING_FLOW: BookingFlow = {
  state: "exploring",
  consumedConfirmationTurnIds: [],
}

export const DEFAULT_AVA_SESSION: AvaSession = {
  facts: DEFAULT_STAY_FACTS,
  flow: DEFAULT_BOOKING_FLOW,
  policy: DEFAULT_BOOKING_POLICY,
  appliedTurnIds: [],
}

export function createAvaSession(args?: {
  facts?: FactsUpdate
  flow?: Partial<BookingFlow>
  policy?: Partial<BookingPolicy>
}): AvaSession {
  const session: AvaSession = {
    facts: cloneStayFacts(DEFAULT_STAY_FACTS),
    flow: normaliseFlow(args?.flow),
    policy: { ...DEFAULT_BOOKING_POLICY, ...args?.policy },
    appliedTurnIds: [],
  }

  return args?.facts ? { ...session, facts: mergeFacts(session.facts, args.facts, "profile") } : session
}

export function applyUnderstanding(session: AvaSession, understanding: ConversationUnderstanding): AvaSession {
  if (session.appliedTurnIds.includes(understanding.turnId)) return session

  const facts = understanding.facts ? mergeFacts(session.facts, understanding.facts, "understanding", understanding.turnId) : session.facts
  const flow = understanding.intent === "revise_plan" || understanding.intent === "reject_pending_booking"
    ? clearPendingFinalRecap(session.flow, "booking_preflight")
    : session.flow

  return {
    ...session,
    facts,
    flow,
    appliedTurnIds: [...session.appliedTurnIds, understanding.turnId],
  }
}

export function decideNextAction(session: AvaSession, latestUnderstanding?: ConversationUnderstanding): AvaDecision {
  const facts = normaliseSelectedPlan(session.facts)
  const flow = normaliseFlow(session.flow)
  const policy = { ...DEFAULT_BOOKING_POLICY, ...session.policy }
  const readiness = buildReadiness(facts, flow, policy, latestUnderstanding)
  const nextAction = chooseNextAction({ facts, flow, policy, readiness, latestUnderstanding })
  const missingForBooking = readiness.canPrepareBooking.missing ?? []

  return {
    facts,
    flow,
    policy,
    readiness,
    nextAction,
    debug: {
      planHash: facts.selectedPlan?.planHash,
      latestTurnId: latestUnderstanding?.turnId,
      missingForBooking,
    },
  }
}

export function buildReadiness(
  facts: StayFacts,
  flow: BookingFlow = DEFAULT_BOOKING_FLOW,
  policy: BookingPolicy = DEFAULT_BOOKING_POLICY,
  latestUnderstanding?: ConversationUnderstanding,
): AvaReadiness {
  return {
    canRecommendRooms: guardCanRecommendRooms(facts),
    canPrepareBooking: guardCanPrepareBooking(facts, policy),
    canOpenBooking: guardCanOpenBooking(facts, flow, policy, latestUnderstanding),
  }
}

export function guardCanRecommendRooms(facts: StayFacts): GuardResult {
  const missing: MissingFact[] = []

  if (!facts.dates.arrival || !facts.dates.departure) missing.push(missingTravelDates())
  if (!facts.party.adults) missing.push(missingGuestParty())

  return missing.length
    ? { allowed: false, reason: "Room recommendation needs dates and party composition.", missing }
    : { allowed: true, reason: "Room recommendation facts are present." }
}

export function guardCanPrepareBooking(facts: StayFacts, policy: BookingPolicy = DEFAULT_BOOKING_POLICY): GuardResult {
  const missing: MissingFact[] = []

  if (!facts.dates.arrival && !facts.dates.departure) missing.push(missingTravelDates())
  else {
    if (!facts.dates.arrival) missing.push(missingArrivalDate())
    if (!facts.dates.departure) missing.push(missingDepartureDate())
  }

  if (!facts.party.adults) missing.push(missingGuestParty())

  const children = facts.party.children?.value ?? 0
  const ages = facts.party.childrenAges?.value ?? []
  if (children > 0 && ages.length < children) missing.push(missingChildrenAges())

  if (!facts.selectedPlan) missing.push(missingRoomPlan())
  if (policy.accessibilityMode !== "optional" && facts.accessibility.status === "unknown") missing.push(missingAccessibility(policy.accessibilityMode))

  return missing.length
    ? { allowed: false, reason: "Booking preflight is missing required structured facts.", missing }
    : { allowed: true, reason: "Booking preflight facts are present." }
}

export function guardCanOpenBooking(
  facts: StayFacts,
  flow: BookingFlow,
  policy: BookingPolicy = DEFAULT_BOOKING_POLICY,
  latestUnderstanding?: ConversationUnderstanding,
): GuardResult {
  if (flow.state !== "awaiting_final_confirmation") {
    return {
      allowed: false,
      reason: "Booking can only open after the final recap has been presented.",
      requiredState: "awaiting_final_confirmation",
    }
  }

  if (!flow.pendingFinalRecap) {
    return { allowed: false, reason: "No pending final recap is registered." }
  }

  if (!facts.selectedPlan) return { allowed: false, reason: "No selected room plan exists.", missing: [missingRoomPlan()] }

  if (flow.pendingFinalRecap.planHash !== facts.selectedPlan.planHash) {
    return { allowed: false, reason: "The selected plan differs from the pending final recap." }
  }

  if (!latestUnderstanding) return { allowed: false, reason: "No guest confirmation turn is available." }

  if (flow.consumedConfirmationTurnIds.includes(latestUnderstanding.turnId)) {
    return { allowed: false, reason: "This confirmation turn was already consumed." }
  }

  if (latestUnderstanding.confirmation?.targetPlanHash && latestUnderstanding.confirmation.targetPlanHash !== flow.pendingFinalRecap.planHash) {
    return { allowed: false, reason: "The confirmation targets a different plan." }
  }

  const isAffirmed =
    latestUnderstanding.intent === "confirm_pending_booking" &&
    latestUnderstanding.confirmation?.kind === "affirm" &&
    latestUnderstanding.confirmation.confidence >= policy.minimumConfirmationConfidence

  return isAffirmed
    ? { allowed: true, reason: "The guest confirmed the pending plan." }
    : { allowed: false, reason: "The latest structured turn is not a confident confirmation." }
}

export function markFinalRecapPresented(
  session: AvaSession,
  args: { assistantTurnId: string; planHash?: string; presentedAt?: number },
): AvaSession {
  const facts = normaliseSelectedPlan(session.facts)
  const planHash = args.planHash ?? facts.selectedPlan?.planHash ?? hashBookingPlan(facts)

  return {
    ...session,
    facts,
    flow: {
      ...normaliseFlow(session.flow),
      state: "awaiting_final_confirmation",
      pendingFinalRecap: {
        assistantTurnId: args.assistantTurnId,
        planHash,
        presentedAt: args.presentedAt,
      },
    },
  }
}

export function markBookingOpening(
  session: AvaSession,
  args: { confirmationTurnId: string; planHash?: string },
): AvaSession {
  const facts = normaliseSelectedPlan(session.facts)
  const planHash = args.planHash ?? facts.selectedPlan?.planHash ?? session.flow.pendingFinalRecap?.planHash ?? hashBookingPlan(facts)

  return {
    ...session,
    facts,
    flow: {
      ...normaliseFlow(session.flow),
      state: "booking_opening",
      consumedConfirmationTurnIds: unique([...session.flow.consumedConfirmationTurnIds, args.confirmationTurnId]),
      opening: {
        confirmationTurnId: args.confirmationTurnId,
        planHash,
      },
    },
  }
}

export function markBookingOpened(session: AvaSession, args: { openedTurnId: string }): AvaSession {
  return {
    ...session,
    flow: {
      ...normaliseFlow(session.flow),
      state: "booking_opened",
      openedTurnId: args.openedTurnId,
    },
  }
}

export function hashBookingPlan(facts: StayFacts): string {
  const payload = stableStringify({
    destination: facts.destination?.value,
    arrival: facts.dates.arrival?.value,
    departure: facts.dates.departure?.value,
    adults: facts.party.adults?.value,
    children: facts.party.children?.value ?? 0,
    childrenAges: facts.party.childrenAges?.value ?? [],
    roomCount: facts.selectedPlan?.roomCount ?? facts.roomIntent.roomCount?.value,
    roomType: facts.selectedPlan?.roomType ?? facts.roomIntent.roomType?.value,
    view: facts.selectedPlan?.view ?? facts.roomIntent.view?.value,
    sharing: facts.roomIntent.sharing?.value,
    accessibility: facts.accessibility.status,
    accessibilityNotes: facts.accessibility.notes?.value,
  })

  return `plan_${fnv1a(payload)}`
}

export function avaWorkflowPolicyText(): string {
  return [
    "Ava's booking gate consumes structured conversation understanding only.",
    "Natural-language interpretation belongs upstream; this layer only merges facts, checks readiness, and gates tools.",
    "A final recap is a one-time flow state. After it is presented, wait for a later structured confirmation of the same plan.",
    "open_booking is allowed only for a confident confirm_pending_booking turn against the pending plan.",
  ].join("\n")
}

export function personaCheckpointPolicyText(): string {
  return avaWorkflowPolicyText()
}

function chooseNextAction(args: {
  facts: StayFacts
  flow: BookingFlow
  policy: BookingPolicy
  readiness: AvaReadiness
  latestUnderstanding?: ConversationUnderstanding
}): AvaNextAction {
  const { facts, flow, readiness, latestUnderstanding } = args

  if (flow.state === "awaiting_final_confirmation") {
    if (readiness.canOpenBooking.allowed && latestUnderstanding) {
      return {
        type: "OPEN_BOOKING",
        tool: "open_booking",
        reason: readiness.canOpenBooking.reason,
        planHash: facts.selectedPlan?.planHash,
        confirmationTurnId: latestUnderstanding.turnId,
      }
    }

    if (!latestUnderstanding) {
      return { type: "WAIT_FOR_GUEST", reason: "Ava has presented the final recap and is waiting for a guest turn." }
    }

    if (latestUnderstanding.intent === "reject_pending_booking" || latestUnderstanding.confirmation?.kind === "deny" || latestUnderstanding.confirmation?.kind === "revise") {
      return { type: "REVISE_ROOM_PLAN", reason: "The guest rejected or revised the pending booking." }
    }

    return { type: "DO_NOT_REPEAT_FINAL_RECAP", reason: "A final recap is already pending; do not present it again." }
  }

  if (latestUnderstanding?.intent === "request_booking" || flow.state === "booking_preflight") {
    if (!readiness.canPrepareBooking.allowed) {
      const missing = firstChatMissing(readiness.canPrepareBooking.missing)
      if (missing) return { type: "ASK_MISSING_FACT", reason: missing.reason, missing }
    }

    return {
      type: "PRESENT_FINAL_RECAP",
      reason: "Booking facts are complete and the guest requested booking.",
      planHash: facts.selectedPlan?.planHash ?? hashBookingPlan(facts),
    }
  }

  if (latestUnderstanding?.intent === "revise_plan" || latestUnderstanding?.intent === "request_room_plan") {
    if (!readiness.canRecommendRooms.allowed) {
      const missing = firstChatMissing(readiness.canRecommendRooms.missing)
      if (missing) return { type: "ASK_MISSING_FACT", reason: missing.reason, missing }
    }

    return {
      type: "PROPOSE_ROOM_PLAN",
      tool: "propose_room_plan",
      reason: "The guest is working on the room plan and recommendation facts are present.",
    }
  }

  if (latestUnderstanding?.intent === "continue_experience") {
    return {
      type: "TRAVEL_TO_HOTEL",
      tool: "travel_to_hotel",
      reason: "The guest wants to continue the hotel experience.",
    }
  }

  return { type: "ANSWER_OR_CONTINUE", reason: "No guarded booking action is required." }
}

function mergeFacts(base: StayFacts, update: FactsUpdate, source: FactSource, turnId?: string): StayFacts {
  const next = cloneStayFacts(base)

  if (update.destination !== undefined) next.destination = nullableFact(update.destination, source, turnId)

  if (update.dates) {
    if (update.dates.arrival !== undefined) next.dates.arrival = nullableFact(update.dates.arrival, source, turnId)
    if (update.dates.departure !== undefined) next.dates.departure = nullableFact(update.dates.departure, source, turnId)
  }

  if (update.party) {
    if (update.party.adults !== undefined) next.party.adults = nullableFact(update.party.adults, source, turnId)
    if (update.party.children !== undefined) next.party.children = nullableFact(update.party.children, source, turnId)
    if (update.party.childrenAges !== undefined) next.party.childrenAges = nullableFact(update.party.childrenAges, source, turnId)
    if (update.party.relation !== undefined) next.party.relation = nullableFact(update.party.relation, source, turnId)
  }

  if (update.roomIntent) {
    if (update.roomIntent.roomCount !== undefined) next.roomIntent.roomCount = nullableFact(update.roomIntent.roomCount, source, turnId)
    if (update.roomIntent.roomType !== undefined) next.roomIntent.roomType = nullableFact(update.roomIntent.roomType, source, turnId)
    if (update.roomIntent.view !== undefined) next.roomIntent.view = nullableFact(update.roomIntent.view, source, turnId)
    if (update.roomIntent.sharing !== undefined) next.roomIntent.sharing = nullableFact(update.roomIntent.sharing, source, turnId)
    if (update.roomIntent.proximity !== undefined) next.roomIntent.proximity = nullableFact(update.roomIntent.proximity, source, turnId)
    if (update.roomIntent.notes !== undefined) next.roomIntent.notes = nullableFact(update.roomIntent.notes, source, turnId)
  }

  if (update.accessibility) {
    if (update.accessibility.status !== undefined && update.accessibility.status !== null) next.accessibility.status = update.accessibility.status
    if (update.accessibility.notes !== undefined) next.accessibility.notes = nullableFact(update.accessibility.notes, source, turnId)
  }

  if (update.account) {
    if (update.account.name !== undefined) next.account.name = nullableFact(update.account.name, source, turnId)
    if (update.account.email !== undefined) next.account.email = nullableFact(update.account.email, source, turnId)
    if (update.account.phone !== undefined) next.account.phone = nullableFact(update.account.phone, source, turnId)
  }

  if (update.selectedPlan !== undefined) {
    next.selectedPlan = update.selectedPlan ? { ...update.selectedPlan, source: update.selectedPlan.source ?? "understanding" } : undefined
  }

  return normaliseSelectedPlan(next)
}

function normaliseSelectedPlan(facts: StayFacts): StayFacts {
  if (!facts.selectedPlan) return facts
  const selectedPlan = { ...facts.selectedPlan }
  selectedPlan.planHash = selectedPlan.planHash ?? hashBookingPlan({ ...facts, selectedPlan })
  return { ...facts, selectedPlan }
}

function nullableFact<T>(value: T | null, source: FactSource, turnId?: string): Fact<T> | undefined {
  return value === null ? undefined : { value, source, evidenceTurnId: turnId }
}

function cloneStayFacts(facts: StayFacts): StayFacts {
  return {
    destination: facts.destination ? { ...facts.destination } : undefined,
    dates: {
      arrival: facts.dates.arrival ? { ...facts.dates.arrival } : undefined,
      departure: facts.dates.departure ? { ...facts.dates.departure } : undefined,
    },
    party: {
      adults: facts.party.adults ? { ...facts.party.adults } : undefined,
      children: facts.party.children ? { ...facts.party.children } : undefined,
      childrenAges: facts.party.childrenAges ? { ...facts.party.childrenAges, value: [...facts.party.childrenAges.value] } : undefined,
      relation: facts.party.relation ? { ...facts.party.relation } : undefined,
    },
    roomIntent: {
      roomCount: facts.roomIntent.roomCount ? { ...facts.roomIntent.roomCount } : undefined,
      roomType: facts.roomIntent.roomType ? { ...facts.roomIntent.roomType } : undefined,
      view: facts.roomIntent.view ? { ...facts.roomIntent.view } : undefined,
      sharing: facts.roomIntent.sharing ? { ...facts.roomIntent.sharing } : undefined,
      proximity: facts.roomIntent.proximity ? { ...facts.roomIntent.proximity } : undefined,
      notes: facts.roomIntent.notes ? { ...facts.roomIntent.notes, value: [...facts.roomIntent.notes.value] } : undefined,
    },
    accessibility: {
      status: facts.accessibility.status,
      notes: facts.accessibility.notes ? { ...facts.accessibility.notes } : undefined,
    },
    selectedPlan: facts.selectedPlan ? { ...facts.selectedPlan } : undefined,
    account: {
      name: facts.account.name ? { ...facts.account.name } : undefined,
      email: facts.account.email ? { ...facts.account.email } : undefined,
      phone: facts.account.phone ? { ...facts.account.phone } : undefined,
    },
  }
}

function normaliseFlow(flow?: Partial<BookingFlow>): BookingFlow {
  return {
    state: flow?.state ?? "exploring",
    pendingFinalRecap: flow?.pendingFinalRecap,
    consumedConfirmationTurnIds: flow?.consumedConfirmationTurnIds ? [...flow.consumedConfirmationTurnIds] : [],
    opening: flow?.opening,
    openedTurnId: flow?.openedTurnId,
  }
}

function clearPendingFinalRecap(flow: BookingFlow, state: BookingFlowState): BookingFlow {
  return {
    ...normaliseFlow(flow),
    state,
    pendingFinalRecap: undefined,
    opening: undefined,
  }
}

function firstChatMissing(missing?: MissingFact[]): MissingFact | undefined {
  return missing?.find((m) => m.owner === "chat") ?? missing?.[0]
}

function missingTravelDates(): MissingFact {
  return {
    id: "travel_dates",
    owner: "chat",
    label: "Travel dates",
    reason: "Arrival and departure dates are required.",
  }
}

function missingArrivalDate(): MissingFact {
  return {
    id: "arrival_date",
    owner: "chat",
    label: "Arrival date",
    reason: "Arrival date is required.",
  }
}

function missingDepartureDate(): MissingFact {
  return {
    id: "departure_date",
    owner: "chat",
    label: "Departure date",
    reason: "Departure date is required.",
  }
}

function missingGuestParty(): MissingFact {
  return {
    id: "guest_party",
    owner: "chat",
    label: "Party composition",
    reason: "Adult party composition is required.",
  }
}

function missingChildrenAges(): MissingFact {
  return {
    id: "children_ages",
    owner: "chat",
    label: "Children ages",
    reason: "Children ages are required because children are present.",
  }
}

function missingRoomPlan(): MissingFact {
  return {
    id: "room_plan",
    owner: "chat",
    label: "Selected room plan",
    reason: "A selected room plan is required.",
  }
}

function missingAccessibility(mode: AccessibilityMode): MissingFact {
  return {
    id: "accessibility",
    owner: "chat",
    label: "Accessibility needs",
    reason: mode === "required" ? "Accessibility status is required by policy." : "Accessibility should be checked before booking by policy.",
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

function fnv1a(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
