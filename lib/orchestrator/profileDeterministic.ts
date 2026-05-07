import type { UserProfile } from "@/lib/context"
import type { ProfileAwaiting } from "./profileFastPath"

export type DeterministicProfileInput = {
  latestMessage: string
  profile: {
    familySize?: number
    startDate?: Date | null
    endDate?: Date | null
    travelPurpose?: string
    guestComposition?: UserProfile["guestComposition"]
    roomAllocation?: number[]
  }
  awaiting: ProfileAwaiting
  today?: Date
}

export type DeterministicProfileResult =
  | {
      handled: true
      decision: "ask_next" | "clarify" | "ready"
      confidence: number
      updates: Partial<UserProfile>
      speech: string
      awaiting: ProfileAwaiting
      reasons: string[]
    }
  | {
      handled: false
      confidence: number
      reasons: string[]
    }

type Parsed = {
  updates: Partial<UserProfile>
  clarifyingSpeech?: string
  confidence: number
  reasons: string[]
}

const CANNED_SPEECH: Record<Exclude<ProfileAwaiting, "dates_and_guests" | "extracting" | "interests" | "ready">, string> = {
  dates: "What are your travel dates?",
  guests: "How many guests are traveling?",
  guest_breakdown: "How many adults and children are in your group?",
  children_ages: "What are the children's ages?",
  travel_purpose: "What brings you to the area?",
  room_distribution: "How would you like to split your guests across rooms?",
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}

function clean(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null
  const digits = raw.match(/\d+/)?.[0]
  if (digits) return Number(digits)
  return NUMBER_WORDS[raw.toLowerCase()] ?? null
}

function dateFrom(year: number, monthName: string, dayRaw: string): Date | null {
  const month = MONTHS[monthName.toLowerCase()]
  const day = Number(dayRaw.replace(/\D/g, ""))
  if (month === undefined || !day) return null
  const date = new Date(year, month, day)
  return Number.isNaN(date.getTime()) ? null : date
}

function parseDates(text: string, today: Date): Parsed {
  const lower = text.toLowerCase()
  if (/\b(mid|sometime|around|about|roughly|maybe|next week|next month|spring|summer|fall|autumn|winter)\b/i.test(lower)) {
    return {
      updates: {},
      clarifyingSpeech: "Could you give me specific arrival and departure dates?",
      confidence: 0.95,
      reasons: ["vague_dates"],
    }
  }

  const year = today.getFullYear()
  const patterns: RegExp[] = [
    /(?:from|between)?\s*(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|through|until|and)\s*(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?([a-zA-Z]+)/i,
    /([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|through|until|and)\s*(?:([a-zA-Z]+)\s+)?(\d{1,2})(?:st|nd|rd|th)?/i,
  ]

  const dayMonth = text.match(patterns[0])
  if (dayMonth) {
    const [, d1, d2, month] = dayMonth
    const startDate = dateFrom(year, month, d1)
    const endDate = dateFrom(year, month, d2)
    if (startDate && endDate) {
      return { updates: { startDate, endDate }, confidence: 0.96, reasons: ["date_range_day_month"] }
    }
  }

  const monthDay = text.match(patterns[1])
  if (monthDay) {
    const [, m1, d1, maybeM2, d2] = monthDay
    const startDate = dateFrom(year, m1, d1)
    const endDate = dateFrom(year, maybeM2 || m1, d2)
    if (startDate && endDate) {
      return { updates: { startDate, endDate }, confidence: 0.96, reasons: ["date_range_month_day"] }
    }
  }

  return { updates: {}, confidence: 0.2, reasons: ["dates_not_parsed"] }
}

function parsePartyAndComposition(text: string): Parsed {
  const lower = text.toLowerCase()
  const adultChild = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+adults?\b.*\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:children|kids?)\b/i)
    ?? lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:children|kids?)\b.*\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+adults?\b/i)
  if (adultChild) {
    const first = toNumber(adultChild[1])
    const second = toNumber(adultChild[2])
    if (first != null && second != null) {
      const childrenFirst = /(?:children|kids?)/i.test(adultChild[0].split(adultChild[2])[0] ?? "")
      const adults = childrenFirst ? second : first
      const children = childrenFirst ? first : second
      return {
        updates: { familySize: adults + children, guestComposition: { adults, children } },
        confidence: 0.96,
        reasons: ["adult_child_composition"],
      }
    }
  }

  const adultsOnly = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:adults?|grown[- ]?ups?)\b/i)
  if (adultsOnly) {
    const adults = toNumber(adultsOnly[1])
    if (adults != null) {
      return {
        updates: { familySize: adults, guestComposition: { adults, children: 0 } },
        confidence: 0.97,
        reasons: ["adults_only_count"],
      }
    }
  }

  const guests = lower.match(/\b(?:party of|group of|family of|we(?:'re| are)?|we will be|for)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i)
    ?? lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:guests?|people|travellers|travelers|of us)\b/i)
  if (guests) {
    const familySize = toNumber(guests[1])
    if (familySize != null) {
      return { updates: { familySize }, confidence: 0.92, reasons: ["party_size"] }
    }
  }

  if (/\b(couple|two of us|the two of us|me and my (?:wife|husband|partner|spouse))\b/i.test(lower)) {
    return {
      updates: { familySize: 2, guestComposition: { adults: 2, children: 0 } },
      confidence: 0.95,
      reasons: ["couple"],
    }
  }

  return { updates: {}, confidence: 0.2, reasons: ["party_not_parsed"] }
}

function parseGuestBreakdown(text: string, partySize?: number): Parsed {
  const lower = text.toLowerCase()
  const composed = parsePartyAndComposition(text)
  if (composed.updates.guestComposition) return composed

  if (partySize && /\b(all|only|just)\s+adults?\b|\bno\s+(?:kids?|children|little ones)\b/i.test(lower)) {
    return {
      updates: { guestComposition: { adults: partySize, children: 0 }, familySize: partySize },
      confidence: 0.96,
      reasons: ["all_adults_followup"],
    }
  }

  const childrenOnly = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:children|kids?)\b/i)
  if (partySize && childrenOnly) {
    const children = toNumber(childrenOnly[1])
    if (children != null && children <= partySize) {
      return {
        updates: { guestComposition: { adults: partySize - children, children }, familySize: partySize },
        confidence: 0.9,
        reasons: ["children_count_followup"],
      }
    }
  }

  return { updates: {}, confidence: 0.2, reasons: ["breakdown_not_parsed"] }
}

// Bucket vocabulary → representative age. Ages don't need to be exact for the
// room planner — we only need infant-vs-grown-up resolution.
const BUCKET_AGE: Record<string, number> = {
  newborn: 0, newborns: 0,
  infant: 1, infants: 1,
  baby: 1, babies: 1,
  toddler: 3, toddlers: 3,
  preschooler: 4, preschoolers: 4,
  teen: 15, teens: 15,
  teenager: 15, teenagers: 15,
}

function broadcast(
  age: number,
  children: number,
  composition: UserProfile["guestComposition"] | undefined,
  reason: string,
  confidence: number,
): Parsed {
  return {
    updates: {
      guestComposition: {
        adults: composition?.adults ?? 0,
        children,
        childrenAges: Array<number>(children).fill(age),
      },
    },
    confidence,
    reasons: [reason],
  }
}

function parseChildrenAges(text: string, composition?: UserProfile["guestComposition"]): Parsed {
  const children = composition?.children
  if (!children || children <= 0) return { updates: {}, confidence: 0.2, reasons: ["no_children_context"] }
  const lower = text.toLowerCase()

  // 1. Approximate qualifiers — "under 10", "around 5", "about 8", "roughly 12".
  //    Checked first so "under 10" with 1 child doesn't get treated as exact age 10.
  const approxMatch = lower.match(
    /\b(under|below|over|above|around|about|roughly|approximately|nearly)\s+(\d{1,2})\b/i,
  )
  if (approxMatch) {
    const qualifier = approxMatch[1].toLowerCase()
    const n = Number(approxMatch[2])
    if (n >= 0 && n < 18) {
      let rep = n
      if (qualifier === "under" || qualifier === "below") rep = Math.max(0, n - 2)
      else if (qualifier === "over" || qualifier === "above") rep = Math.min(17, n + 2)
      return broadcast(rep, children, composition, "approximate_age_broadcast", 0.9)
    }
  }

  // 2. Range — "between 5 and 8", "from 5 to 8", "5 to 8". Broadcast midpoint.
  //    Plain "X and Y" is intentionally NOT a range (it's the natural way to list
  //    two distinct ages, e.g. "5 and 8" with 2 kids).
  const rangeMatch =
    lower.match(/\bbetween\s+(\d{1,2})\s+and\s+(\d{1,2})\b/i)
    ?? lower.match(/\bfrom\s+(\d{1,2})\s+to\s+(\d{1,2})\b/i)
    ?? lower.match(/\b(\d{1,2})\s+to\s+(\d{1,2})\b/)
  if (rangeMatch) {
    const lo = Number(rangeMatch[1])
    const hi = Number(rangeMatch[2])
    if (lo >= 0 && hi < 18 && lo <= hi) {
      const mid = Math.round((lo + hi) / 2)
      return broadcast(mid, children, composition, "age_range_midpoint", 0.88)
    }
  }

  const digitAges = Array.from(lower.matchAll(/\b(\d{1,2})\b/g))
    .map((m) => Number(m[1]))
    .filter((n) => n >= 0 && n < 18)

  // 3. Single digit + broadcast quantifier — "both 2 years old", "all 5", "each 4".
  if (digitAges.length === 1 && /\b(both|all|each|every)\b/i.test(lower)) {
    return broadcast(digitAges[0], children, composition, "broadcast_single_age", 0.93)
  }

  // 4. Exact-count digits — "5 and 8" for 2 kids, "2, 4, 6, 8" for 4 kids.
  if (digitAges.length === children) {
    return {
      updates: {
        guestComposition: {
          adults: composition?.adults ?? 0,
          children,
          childrenAges: digitAges,
        },
      },
      confidence: 0.96,
      reasons: ["children_ages"],
    }
  }

  // 5. Bucket vocabulary — "they are toddlers", "all infants". Only when there
  //    are no stray digits (mixing digits + buckets is too ambiguous to resolve
  //    deterministically — fall through to clarify or the LLM).
  if (digitAges.length === 0) {
    const matchedAges = new Set<number>()
    for (const [bucket, age] of Object.entries(BUCKET_AGE)) {
      if (new RegExp(`\\b${bucket}\\b`).test(lower)) matchedAges.add(age)
    }
    if (matchedAges.size === 1) {
      return broadcast([...matchedAges][0], children, composition, "bucket_broadcast", 0.9)
    }
    if (matchedAges.size > 1) {
      return {
        updates: {},
        clarifyingSpeech: "Got it — could you give me a rough age for each child?",
        confidence: 0.9,
        reasons: ["mixed_buckets"],
      }
    }
  }

  // 6. Count mismatch — same wording as before.
  if (digitAges.length > 0) {
    const speech =
      digitAges.length < children
        ? `I caught only ${digitAges.length} of the ${children} ages - could you share all ${children}?`
        : `I caught ${digitAges.length} ages but there are ${children} children - could you tell me each child's age?`
    return { updates: {}, clarifyingSpeech: speech, confidence: 0.94, reasons: ["age_count_mismatch"] }
  }

  return { updates: {}, confidence: 0.2, reasons: ["ages_not_parsed"] }
}

function parseTravelPurpose(text: string): Parsed {
  const lower = text.toLowerCase()
  const pairs: Array<[RegExp, string]> = [
    [/\b(family vacation|family holiday|family trip|with the family|with the kids)\b/i, "family vacation"],
    [/\b(business|work trip|conference|corporate|meetings?)\b/i, "business"],
    [/\b(honeymoon)\b/i, "honeymoon"],
    [/\b(anniversary|birthday|celebration|wedding)\b/i, "celebration"],
    [/\b(romantic|couples?|getaway)\b/i, "romantic getaway"],
    [/\b(leisure|vacation|holiday|relax|relaxing|unwind|sightseeing|tourism|pleasure)\b/i, "leisure"],
  ]
  for (const [pattern, purpose] of pairs) {
    if (pattern.test(lower)) {
      return { updates: { travelPurpose: purpose }, confidence: 0.9, reasons: ["travel_purpose_keyword"] }
    }
  }
  return { updates: {}, confidence: 0.25, reasons: ["purpose_not_parsed"] }
}

function parseRoomAllocation(text: string, partySize?: number): Parsed {
  if (!partySize || partySize <= 1) return { updates: {}, confidence: 0.2, reasons: ["no_room_allocation_context"] }
  const lower = text.toLowerCase()

  if (/\b(all together|same room|one room|share|together)\b/i.test(lower)) {
    return { updates: { roomAllocation: [partySize] }, confidence: 0.95, reasons: ["all_together"] }
  }
  if (/\b(separate|own room|individual|one each|room each|private)\b/i.test(lower)) {
    return {
      updates: { roomAllocation: Array(partySize).fill(1) },
      confidence: 0.92,
      reasons: ["separate_rooms"],
    }
  }

  const nums = Array.from(lower.matchAll(/\b(\d+)\b/g)).map((m) => Number(m[1])).filter((n) => n > 0)
  const explicitSplit = /\b(split|rooms?|room|each|and|,)\b/i.test(lower)
  if (explicitSplit && nums.length >= 2) {
    let allocation: number[] | null = null
    const roomsEach = lower.match(/\b(\d+)\s+rooms?\b.*\b(\d+)\s+(?:guests?|people)?\s*each\b/i)
    if (roomsEach) {
      allocation = Array(Number(roomsEach[1])).fill(Number(roomsEach[2]))
    } else if (/\brooms?\b/i.test(lower) && nums.length >= 3) {
      allocation = nums.slice(1)
    } else {
      allocation = nums
    }

    const sum = allocation.reduce((total, n) => total + n, 0)
    if (sum === partySize) {
      return { updates: { roomAllocation: allocation }, confidence: 0.93, reasons: ["explicit_room_split"] }
    }
    return {
      updates: {},
      clarifyingSpeech: `That room split adds up to ${sum}, but I have ${partySize} guests - how would you like to divide everyone?`,
      confidence: 0.92,
      reasons: ["room_split_sum_mismatch"],
    }
  }

  const roomCount = lower.match(/\b(\d+)\s+rooms?\b/i)
  if (roomCount) {
    const count = Number(roomCount[1])
    if (count > 0 && partySize % count === 0) {
      return {
        updates: { roomAllocation: Array(count).fill(partySize / count) },
        confidence: 0.88,
        reasons: ["even_room_count"],
      }
    }
    return {
      updates: {},
      clarifyingSpeech: `How many guests should I place in each of the ${count} rooms?`,
      confidence: 0.9,
      reasons: ["room_count_needs_split"],
    }
  }

  return { updates: {}, confidence: 0.25, reasons: ["room_allocation_not_parsed"] }
}

function mergeProfile(
  profile: DeterministicProfileInput["profile"],
  updates: Partial<UserProfile>,
): DeterministicProfileInput["profile"] {
  const guestComposition = updates.guestComposition
    ? { ...(profile.guestComposition ?? {}), ...updates.guestComposition }
    : profile.guestComposition
  const familySize =
    updates.familySize ??
    (guestComposition && typeof guestComposition.adults === "number" && typeof guestComposition.children === "number"
      ? guestComposition.adults + guestComposition.children
      : profile.familySize)

  return {
    ...profile,
    ...updates,
    familySize,
    guestComposition: guestComposition as UserProfile["guestComposition"],
  }
}

function nextAwaiting(profile: DeterministicProfileInput["profile"]): ProfileAwaiting {
  if (!profile.startDate || !profile.endDate) return "dates"
  if (!profile.familySize) return "guests"
  if (!profile.guestComposition) return "guest_breakdown"
  if (
    profile.guestComposition.children > 0 &&
    (!profile.guestComposition.childrenAges ||
      profile.guestComposition.childrenAges.length !== profile.guestComposition.children)
  ) return "children_ages"
  if (!profile.travelPurpose) return "travel_purpose"
  if (profile.familySize > 1) {
    const allocation = profile.roomAllocation
    if (!allocation?.length || allocation.reduce((sum, n) => sum + n, 0) !== profile.familySize) {
      return "room_distribution"
    }
  }
  return "ready"
}

function readySpeech(profile: DeterministicProfileInput["profile"]): string {
  const dates = profile.startDate && profile.endDate
    ? `${profile.startDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} to ${profile.endDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "your dates"
  const guests = profile.guestComposition
    ? `${profile.guestComposition.adults} adults and ${profile.guestComposition.children} children`
    : `${profile.familySize ?? "your"} guests`
  return `Wonderful - I have ${dates}, ${guests}, and a ${profile.travelPurpose ?? "personalized"} stay. Would you like to stop by the virtual lounge first, or go straight to the hotel?`
}

export function evaluateDeterministicProfileTurn(input: DeterministicProfileInput): DeterministicProfileResult {
  const text = clean(input.latestMessage)
  if (!text) return { handled: false, confidence: 0, reasons: ["empty_message"] }

  const today = input.today ?? new Date()
  const updates: Partial<UserProfile> = {}
  const reasons: string[] = []
  let confidence = 1
  let clarifyingSpeech: string | undefined

  const apply = (parsed: Parsed) => {
    Object.assign(updates, parsed.updates)
    reasons.push(...parsed.reasons)
    confidence = Math.min(confidence, parsed.confidence)
    if (parsed.clarifyingSpeech) clarifyingSpeech = parsed.clarifyingSpeech
  }

  if (input.awaiting === "dates" || input.awaiting === "dates_and_guests" || /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}(?:st|nd|rd|th)?\s*(?:to|-|and))/.test(text.toLowerCase())) {
    const parsed = parseDates(text, today)
    if (parsed.confidence >= 0.85 || parsed.clarifyingSpeech) apply(parsed)
  }

  const profileAfterDates = mergeProfile(input.profile, updates)
  if (!clarifyingSpeech && (input.awaiting === "guests" || input.awaiting === "dates_and_guests" || /\b(guests?|people|adults?|children|kids?|couple|two of us|party of|group of)\b/i.test(text))) {
    const parsed = parsePartyAndComposition(text)
    if (parsed.confidence >= 0.85) apply(parsed)
  }

  const profileAfterParty = mergeProfile(profileAfterDates, updates)
  if (!clarifyingSpeech && input.awaiting === "guest_breakdown" && !profileAfterParty.guestComposition) {
    const parsed = parseGuestBreakdown(text, profileAfterParty.familySize)
    if (parsed.confidence >= 0.85) apply(parsed)
  }

  const profileAfterBreakdown = mergeProfile(profileAfterParty, updates)
  if (!clarifyingSpeech && input.awaiting === "children_ages") {
    const parsed = parseChildrenAges(text, profileAfterBreakdown.guestComposition)
    if (parsed.confidence >= 0.85 || parsed.clarifyingSpeech) apply(parsed)
  }

  const profileAfterAges = mergeProfile(profileAfterBreakdown, updates)
  if (!clarifyingSpeech && (input.awaiting === "travel_purpose" || /\b(business|family|honeymoon|anniversary|birthday|leisure|vacation|holiday|romantic|conference|relax|celebration)\b/i.test(text))) {
    const parsed = parseTravelPurpose(text)
    if (parsed.confidence >= 0.85) apply(parsed)
  }

  const profileAfterPurpose = mergeProfile(profileAfterAges, updates)
  if (!clarifyingSpeech && input.awaiting === "room_distribution") {
    const parsed = parseRoomAllocation(text, profileAfterPurpose.familySize)
    if (parsed.confidence >= 0.85 || parsed.clarifyingSpeech) apply(parsed)
  }

  if (clarifyingSpeech) {
    return {
      handled: true,
      decision: "clarify",
      confidence,
      updates,
      speech: clarifyingSpeech,
      awaiting: input.awaiting,
      reasons,
    }
  }

  if (Object.keys(updates).length === 0 || confidence < 0.85) {
    return { handled: false, confidence, reasons: reasons.length ? reasons : ["no_high_confidence_parse"] }
  }

  const merged = mergeProfile(input.profile, updates)
  const awaiting = nextAwaiting(merged)
  if (awaiting === "ready") {
    return {
      handled: true,
      decision: "ready",
      confidence,
      updates,
      speech: readySpeech(merged),
      awaiting,
      reasons,
    }
  }

  if (awaiting === "dates_and_guests" || awaiting === "extracting" || awaiting === "interests") {
    return { handled: false, confidence: 0.4, reasons: [...reasons, `unsupported_awaiting_${awaiting}`] }
  }

  return {
    handled: true,
    decision: "ask_next",
    confidence,
    updates,
    speech: CANNED_SPEECH[awaiting],
    awaiting,
    reasons,
  }
}
