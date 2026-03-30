"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveAvatarContext } from "./context"
import { MessageSender } from "./types"

export type AvatarDerivedProfile = {
  name?: string
  partySize?: number
  destination?: string
  interests: string[]
  startDate?: Date | null
  endDate?: Date | null
  travelPurpose?: string
  budgetRange?: string
  roomTypePreference?: string
  dietaryRestrictions?: string[]
  accessibilityNeeds?: string[]
  amenityPriorities?: string[]
  nationality?: string
  arrivalTime?: string
  guestComposition?: { adults: number; children: number; childrenAges?: number[] }
  distributionPreference?: "together" | "separate" | "auto"
  roomAllocation?: number[]
}

type AIExtractedProfile = {
  name?: string | null
  partySize?: number | null
  destination?: string | null
  startDate?: string | null
  endDate?: string | null
  interests?: string[]
  travelPurpose?: string | null
  budgetRange?: string | null
  roomTypePreference?: string | null
  dietaryRestrictions?: string[]
  accessibilityNeeds?: string[]
  amenityPriorities?: string[]
  nationality?: string | null
  arrivalTime?: string | null
  guestComposition?: { adults: number; children: number; childrenAges?: number[] } | null
  distributionPreference?: "together" | "separate" | "auto" | null
  roomAllocation?: number[] | null
}

const clean = (text: string) => text.trim().replace(/\s+/g, " ")

const titleCase = (text: string) =>
  text
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")

const monthLookup: Record<string, number> = {
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

const parseDate = (monthName: string, day: string): Date | null => {
  const month = monthLookup[monthName.toLowerCase()]
  const dayNum = Number(day.replace(/\D/g, ""))
  if (month === undefined || !dayNum) return null
  const year = new Date().getFullYear()
  const date = new Date(year, month, dayNum)
  return Number.isNaN(date.getTime()) ? null : date
}

const extractWithRegex = (
  userMessages: { message: string; timestamp: number }[]
): AvatarDerivedProfile => {
  const result: AvatarDerivedProfile = { interests: [], startDate: null, endDate: null }
  const interestSet = new Set<string>()

  userMessages.forEach(({ message }) => {
    const text = clean(message)
    const lower = text.toLowerCase()

    // Name extraction - expanded patterns
    if (!result.name) {
      const namePatterns = [
        /\b(?:my name is|i am|i'm|this is|call me|it's)\s+([a-z]+(?:\s+[a-z]+)?)/i,
        /\bname'?s\s+([a-z]+(?:\s+[a-z]+)?)/i,
        /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+here/i,
      ]
      for (const pattern of namePatterns) {
        const match = text.match(pattern)
        if (match?.[1]) {
          result.name = titleCase(match[1])
          break
        }
      }
    }

    // Party size extraction - expanded patterns
    if (!result.partySize) {
      const partyPatterns = [
        /(\d+)\s+(?:people|persons|guests|adults|of us|travelers|travellers)/i,
        /(?:party of|group of|family of)\s+(\d+)/i,
        /with\s+(\d+)\s+(?:friends|family|others|companions|more|kids|children)/i,
        /(?:me and|myself and|my wife and|my husband and|my partner and)\s+(\d+)/i,
        /(?:just me|only me|traveling alone|solo)/i,
        /(?:me and my (?:wife|husband|partner|spouse))/i,
        /(?:couple|two of us|the two of us)/i,
        /(?:family of|with family)/i,
      ]

      for (const pattern of partyPatterns) {
        const match = lower.match(pattern)
        if (match) {
          if (match[1]) {
            const num = Number(match[1])
            // Check if it's "with X" pattern (add 1 for speaker)
            if (pattern.source.includes("with")) {
              result.partySize = num + 1
            } else if (pattern.source.includes("me and")) {
              result.partySize = num + 1
            } else {
              result.partySize = num
            }
          } else if (pattern.source.includes("just me") || pattern.source.includes("solo")) {
            result.partySize = 1
          } else if (pattern.source.includes("couple") || pattern.source.includes("two of us")) {
            result.partySize = 2
          } else if (pattern.source.includes("me and my")) {
            result.partySize = 2
          }
          break
        }
      }
    }

    // Destination extraction - expanded patterns
    if (!result.destination) {
      const destPatterns = [
        /\b(?:to|for|visiting|heading to|going to|travel(?:ing|ling)? to|trip to|vacation (?:in|to))\s+([a-zA-Z][a-zA-Z\s,']+?)(?:[.,!?]|$|\s+(?:for|from|in|on|and|with|next|this))/i,
        /\bdestination\s+(?:is|would be|:)\s*([a-zA-Z\s,']+?)(?:[.,!?]|$)/i,
        /\b(?:lake como|italy|rome|rotterdam|paris|london|new york|tokyo|dubai|maldives|bali|thailand|spain|greece|miami|hawaii)\b/i,
      ]
      for (const pattern of destPatterns) {
        const match = text.match(pattern)
        if (match?.[1]) {
          const dest = clean(match[1])
          if (dest.length > 2 && dest.length < 50) {
            result.destination = titleCase(dest)
            break
          }
        } else if (match?.[0] && !match[1]) {
          // Direct match for known destinations
          result.destination = titleCase(match[0])
          break
        }
      }
    }

    // Date extraction - expanded patterns
    if (!result.startDate || !result.endDate) {
      // Pattern: "15th to 20th of March" or "15-20 March"
      const range1 = text.match(
        /(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|through|until|and)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?([a-zA-Z]+)/i,
      )
      // Pattern: "March 15 to March 20" or "March 15-20"
      const range2 = text.match(
        /([a-zA-Z]+)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|through|until|and)\s*(?:([a-zA-Z]+)\s*)?(\d{1,2})(?:st|nd|rd|th)?/i,
      )
      // Pattern: "from/between March 15 to 20" or "between the 10th and the 15th of May"
      const range3 = text.match(
        /(?:from|between)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|until|and)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-zA-Z]+)/i,
      )
      // Pattern: "next week", "this weekend", etc.
      const relativeMatch = lower.match(/\b(next week|this weekend|next month|next weekend)\b/i)

      let start: Date | null = null
      let end: Date | null = null

      if (range3) {
        // Check range3 first — most specific (requires "from"/"between" keyword)
        const [, d1, d2, monthName] = range3
        start = parseDate(monthName, d1)
        end = parseDate(monthName, d2)
      } else if (range1) {
        const [, d1, d2, monthName] = range1
        start = parseDate(monthName, d1)
        end = parseDate(monthName, d2)
      } else if (range2) {
        const [, m1, d1, maybeM2, d2] = range2
        const m2 = maybeM2 || m1
        start = parseDate(m1, d1)
        end = parseDate(m2, d2)
      } else if (relativeMatch) {
        const today = new Date()
        if (relativeMatch[1].includes("next week")) {
          const nextMonday = new Date(today)
          nextMonday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7))
          start = nextMonday
          end = new Date(nextMonday)
          end.setDate(nextMonday.getDate() + 6)
        } else if (relativeMatch[1].includes("this weekend")) {
          const saturday = new Date(today)
          saturday.setDate(today.getDate() + (6 - today.getDay()))
          start = saturday
          end = new Date(saturday)
          end.setDate(saturday.getDate() + 1)
        }
      }

      if (start && end) {
        result.startDate = start
        result.endDate = end
      }
    }

    // Interests extraction - expanded patterns
    const interestPatterns = [
      /\binterested in\s+([a-z\s,]+?)(?:[.,!?]|$)/i,
      /\blooking for\s+([a-z\s,]+?)(?:[.,!?]|$)/i,
      /\blove\s+([a-z\s,]+?)(?:[.,!?]|$)/i,
      /\binto\s+([a-z\s,]+?)(?:[.,!?]|$)/i,
      /\bwant(?:ing)?\s+(?:to\s+)?(?:do|try|experience)\s+([a-z\s,]+?)(?:[.,!?]|$)/i,
    ]

    // Direct interest keywords (excludes travel-purpose words to avoid confusion)
    const interestKeywords = [
      "spa", "wellness", "relaxation", "beach", "swimming", "pool",
      "hiking", "nature", "mountains", "skiing",
      "culture", "history", "museums", "art", "architecture",
      "food", "gastronomy", "wine", "dining", "culinary",
      "shopping", "nightlife", "entertainment",
      "golf", "tennis", "sports", "fitness",
      "kids",
    ]

    for (const pattern of interestPatterns) {
      const match = lower.match(pattern)
      if (match?.[1]) {
        match[1]
          .split(/,|\band\b/i)
          .map((i) => clean(i))
          .filter((i) => i.length > 2 && i.length < 30)
          .forEach((i) => interestSet.add(i))
      }
    }

    // Check for direct keyword mentions
    for (const keyword of interestKeywords) {
      if (lower.includes(keyword)) {
        interestSet.add(keyword)
      }
    }

    // --- NEW FIELDS ---

    // Dietary restrictions
    const dietaryKeywords = [
      "vegetarian", "vegan", "gluten free", "gluten-free", "halal", "kosher",
      "nut allergy", "nut-free", "dairy free", "dairy-free", "lactose",
      "pescatarian", "celiac", "no pork", "no alcohol",
    ]
    for (const keyword of dietaryKeywords) {
      if (lower.includes(keyword)) {
        if (!result.dietaryRestrictions) result.dietaryRestrictions = []
        result.dietaryRestrictions.push(keyword)
      }
    }

    // Accessibility needs
    const accessibilityKeywords = [
      "wheelchair", "accessible", "mobility", "ground floor",
      "hearing impaired", "visual impairment", "disability", "disabled",
      "step-free", "elevator access",
    ]
    for (const keyword of accessibilityKeywords) {
      if (lower.includes(keyword)) {
        if (!result.accessibilityNeeds) result.accessibilityNeeds = []
        result.accessibilityNeeds.push(keyword)
      }
    }

    // Travel purpose — checked before interests, with broad keyword coverage
    if (!result.travelPurpose) {
      // Ordered longest-first so multi-word phrases match before single words
      const purposeKeywords: [string, string][] = [
        ["family vacation", "family vacation"], ["family holiday", "family vacation"],
        ["family trip", "family vacation"], ["with the family", "family vacation"],
        ["with the kids", "family vacation"], ["with my kids", "family vacation"],
        ["business trip", "business"], ["work trip", "business"], ["corporate", "business"],
        ["conference", "business"], ["meeting", "business"], ["meetings", "business"],
        ["business", "business"], ["work event", "business"],
        ["romantic getaway", "romantic getaway"], ["romantic", "romantic getaway"],
        ["honeymoon", "honeymoon"],
        ["anniversary", "celebration"], ["birthday", "celebration"],
        ["celebration", "celebration"], ["wedding", "celebration"],
        ["adventure", "adventure"], ["exploring", "adventure"], ["explore", "adventure"],
        ["leisure", "leisure"], ["vacation", "leisure"], ["holiday", "leisure"],
        ["getaway", "leisure"], ["pleasure", "leisure"], ["tourism", "leisure"],
        ["tourist", "leisure"], ["sightseeing", "leisure"],
        ["relaxation", "leisure"], ["relaxing", "leisure"], ["relax", "leisure"],
        ["unwind", "leisure"], ["rest", "leisure"], ["break", "leisure"],
        ["time off", "leisure"], ["just for fun", "leisure"], ["for fun", "leisure"],
        ["family", "family vacation"],
      ]
      for (const [keyword, purpose] of purposeKeywords) {
        if (lower.includes(keyword)) {
          result.travelPurpose = purpose
          break
        }
      }
    }

    // Budget range
    if (!result.budgetRange) {
      // Dollar/euro amount patterns
      const rangeMatch = lower.match(/\$\s*(\d[\d,]*)\s*(?:to|-)\s*\$?\s*(\d[\d,]*)/)
      if (rangeMatch) {
        result.budgetRange = `$${rangeMatch[1]}-$${rangeMatch[2]}`
      } else {
        const perNightMatch = lower.match(/(\d{2,}[\d,]*)\s*(?:dollars|euros|pounds|per\s*night|a\s*night|\/night)/)
        if (perNightMatch) {
          result.budgetRange = `~$${perNightMatch[1]}/night`
        } else {
          // "around 300" / "about 400" / "roughly 500"
          const aroundMatch = lower.match(/\b(?:around|about|roughly|approximately)\s+(\d{2,}[\d,]*)/)
          if (aroundMatch) {
            result.budgetRange = `~$${aroundMatch[1]}/night`
          } else {
          const budgetKeywords: Record<string, string> = {
            "budget": "budget", "affordable": "budget", "cheap": "budget",
            "economic": "budget", "mid-range": "mid-range", "mid range": "mid-range",
            "moderate": "mid-range", "luxury": "luxury", "premium": "luxury",
            "high-end": "luxury", "high end": "luxury", "splurge": "luxury",
          }
          for (const [keyword, range] of Object.entries(budgetKeywords)) {
            if (lower.includes(keyword)) {
              result.budgetRange = range
              break
            }
          }
          }
        }
      }
    }

    // Nationality / origin
    if (!result.nationality) {
      const originMatch = text.match(
        /\b(?:from|based in|live in|living in|coming from|traveling from|travelling from)\s+([A-Z][a-zA-Z\s]+?)(?:[.,!?]|$|\s+(?:and|with|for|to))/,
      )
      if (originMatch?.[1]) {
        const origin = clean(originMatch[1])
        if (origin.length > 1 && origin.length < 40) {
          result.nationality = origin
        }
      }
    }

    // Room type preference
    if (!result.roomTypePreference) {
      const roomPrefPatterns = [
        /\b(?:prefer|want|like|looking for)\s+(?:a\s+)?([a-z\s-]+?)\s*(?:room|suite|view)/i,
        /\b(high(?:er)?\s+floor|ground\s+floor|penthouse|ocean\s+view|lake\s+view|garden|balcony|terrace)/i,
        /\b(modern|classic|minimalist|luxurious|spacious|cozy|large)\s+(?:room|suite|style)/i,
      ]
      for (const pattern of roomPrefPatterns) {
        const match = lower.match(pattern)
        if (match?.[1]) {
          result.roomTypePreference = clean(match[1])
          break
        }
      }
    }

    // Arrival time
    if (!result.arrivalTime) {
      const arrivalMatch = lower.match(
        /\b(?:arrive|arriving|check.?in|get there|land)\s+(?:at\s+|around\s+|by\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|morning|afternoon|evening|night|noon|midnight|late|early)/i,
      )
      if (arrivalMatch?.[1]) {
        result.arrivalTime = clean(arrivalMatch[1])
      }
    }

    // Children count and ages for guestComposition
    if (!result.guestComposition) {
      const childMatch = lower.match(/(\d+)\s*(?:kids?|children|child|toddlers?)/)
      if (childMatch) {
        const childCount = Number(childMatch[1])
        const adults = (result.partySize ?? 2) - childCount
        const ageMatches = lower.match(/(?:age[sd]?\s*(?:of\s+)?|aged?\s+)([\d,\s]+(?:and\s+\d+)?)/i)
        let childrenAges: number[] | undefined
        if (ageMatches?.[1]) {
          childrenAges = ageMatches[1]
            .split(/[,\s]+and\s+|[,\s]+/)
            .map(Number)
            .filter((n) => n > 0 && n < 18)
        }
        result.guestComposition = {
          adults: Math.max(1, adults),
          children: childCount,
          childrenAges,
        }
      }
    }

    // Detect "no children" / "all adults" / "just us" / "just the two of us" responses
    if (!result.guestComposition && result.partySize) {
      const noChildrenPattern = /(?:no|zero|none|without)\s*(?:kids?|children|child)|(?:all|only|just)\s*adults?|just\s*(?:us|the\s*two(?:\s*of\s*us)?)|(?:no\s*little\s*ones)|(?:couple|just\s*(?:me\s*and\s*)?(?:my\s*)?(?:wife|husband|partner|spouse))/i
      if (noChildrenPattern.test(lower)) {
        result.guestComposition = {
          adults: result.partySize,
          children: 0,
        }
      }
    }

    // Also detect implicit couple patterns even without partySize
    if (!result.guestComposition && !result.partySize) {
      const coupleMatch = lower.match(/(?:me\s*and\s*my\s*(?:wife|husband|partner|spouse))|(?:just\s*(?:the\s*)?two\s*of\s*us)/i)
      if (coupleMatch) {
        result.partySize = 2
        result.guestComposition = { adults: 2, children: 0 }
      }
    }

    // Room allocation: how many guests per room
    if (!result.roomAllocation) {
      // "2 rooms: 4 and 2" / "2 rooms, 4 and 2" / "2 rooms - 4 and 2"
      const roomsColonMatch = lower.match(/(\d+)\s*rooms?\s*[:\-,]\s*(\d+)\s*(?:and|,)\s*(\d+)(?:\s*(?:and|,)\s*(\d+))?/i)
      // "4 in one room, 2 in another" / "4 in one room and 2 in another"
      const inOneRoomMatch = lower.match(/(\d+)\s*(?:in|for)\s*(?:one|the\s*first|a)\s*room\s*(?:,?\s*(?:and\s*)?)(\d+)\s*(?:in|for)\s*(?:another|the\s*(?:second|other)|a\s*second)\s*room/i)
      // "a room for 4 and a room for 2"
      const roomForMatch = lower.match(/(?:a|one)\s*room\s*(?:for|of|with)\s*(\d+)\s*(?:,?\s*(?:and\s*)?)(?:a(?:nother)?|one\s*more)\s*room\s*(?:for|of|with)\s*(\d+)/i)
      // "split 4 and 2" / "divided 4 and 2"
      const splitMatch = lower.match(/(?:split|divide|divided)\s*(?:as\s*|in\s*|into\s*)?(\d+)\s*(?:and|,)\s*(\d+)(?:\s*(?:and|,)\s*(\d+))?/i)
      // "3 rooms, 2 guests each" / "3 rooms, 2 each"
      const eachMatch = lower.match(/(\d+)\s*rooms?\s*(?:,?\s*)?(\d+)\s*(?:guests?|people|persons?)?\s*each/i)

      if (roomsColonMatch) {
        const alloc = [Number(roomsColonMatch[2]), Number(roomsColonMatch[3])]
        if (roomsColonMatch[4]) alloc.push(Number(roomsColonMatch[4]))
        result.roomAllocation = alloc.filter(n => n > 0)
      } else if (inOneRoomMatch) {
        result.roomAllocation = [Number(inOneRoomMatch[1]), Number(inOneRoomMatch[2])].filter(n => n > 0)
      } else if (roomForMatch) {
        result.roomAllocation = [Number(roomForMatch[1]), Number(roomForMatch[2])].filter(n => n > 0)
      } else if (splitMatch) {
        const alloc = [Number(splitMatch[1]), Number(splitMatch[2])]
        if (splitMatch[3]) alloc.push(Number(splitMatch[3]))
        result.roomAllocation = alloc.filter(n => n > 0)
      } else if (eachMatch) {
        const roomCount = Number(eachMatch[1])
        const guestsPerRoom = Number(eachMatch[2])
        if (roomCount > 0 && guestsPerRoom > 0) {
          result.roomAllocation = Array(roomCount).fill(guestsPerRoom)
        }
      } else {
        // Fallback: "together" → all in one room, "separate" → one per person
        const togetherPattern = /\b(shar(?:e|ing)\s+rooms?|together|same\s+room|all\s+together|one\s+(?:big\s+)?room)\b/i
        const separatePattern = /\b(separate\s+rooms?|own\s+room|individual\s+rooms?|each\s+(?:their|our)\s+own|one\s+each|(?:a\s+)?room\s+each|private\s+rooms?|my\s+own\s+room)\b/i
        const autoPattern = /\b(you\s+decide|you\s+recommend|suggest|up\s+to\s+you|whatever\s+works|your\s+(?:call|choice|recommendation)|best\s+(?:option|layout))\b/i

        if (togetherPattern.test(lower) && result.partySize) {
          result.roomAllocation = [result.partySize]
        } else if (separatePattern.test(lower) && result.partySize) {
          result.roomAllocation = Array(result.partySize).fill(1)
        } else if (autoPattern.test(lower) && result.partySize) {
          // Auto: default to pairs (2 per room), remainder gets its own
          const pairs = Math.floor(result.partySize / 2)
          const remainder = result.partySize % 2
          result.roomAllocation = [
            ...Array(pairs).fill(2),
            ...(remainder ? [1] : []),
          ]
        }
      }
    }
  })

  result.interests = Array.from(interestSet)
  return result
}

export const useUserProfile = (): {
  profile: AvatarDerivedProfile
  userMessages: { message: string; timestamp: number }[]
  triggerAIExtraction: () => Promise<void>
  isExtracting: boolean
  isExtractionPending: boolean
  aiAvailable: boolean
} => {
  const { messages } = useLiveAvatarContext()
  const [aiProfile, setAiProfile] = useState<AIExtractedProfile | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [aiAvailable, setAiAvailable] = useState(true) // Assume available until proven otherwise
  const lastExtractedCount = useRef(0)

  const userMessages = useMemo(
    () =>
      messages
        .filter((m) => m.sender === MessageSender.USER)
        .map(({ message, timestamp }) => ({ message, timestamp })),
    [messages],
  )

  const regexProfile = useMemo(() => extractWithRegex(userMessages), [userMessages])

  // Merge regex and AI extracted profiles
  const profile = useMemo((): AvatarDerivedProfile => {
    if (!aiProfile) return regexProfile

    const mergedInterests = new Set([
      ...regexProfile.interests,
      ...(aiProfile.interests ?? []),
    ])

    const mergedDietary = new Set([
      ...(regexProfile.dietaryRestrictions ?? []),
      ...(aiProfile.dietaryRestrictions ?? []),
    ])
    const mergedAccessibility = new Set([
      ...(regexProfile.accessibilityNeeds ?? []),
      ...(aiProfile.accessibilityNeeds ?? []),
    ])

    return {
      name: aiProfile.name ?? regexProfile.name,
      partySize: aiProfile.partySize ?? regexProfile.partySize,
      destination: aiProfile.destination ?? regexProfile.destination,
      startDate: aiProfile.startDate ? new Date(aiProfile.startDate) : regexProfile.startDate,
      endDate: aiProfile.endDate ? new Date(aiProfile.endDate) : regexProfile.endDate,
      interests: Array.from(mergedInterests),
      travelPurpose: aiProfile.travelPurpose ?? regexProfile.travelPurpose,
      budgetRange: aiProfile.budgetRange ?? regexProfile.budgetRange,
      roomTypePreference: aiProfile.roomTypePreference ?? regexProfile.roomTypePreference,
      dietaryRestrictions: mergedDietary.size > 0 ? Array.from(mergedDietary) : undefined,
      accessibilityNeeds: mergedAccessibility.size > 0 ? Array.from(mergedAccessibility) : undefined,
      amenityPriorities: aiProfile.amenityPriorities ?? regexProfile.amenityPriorities,
      nationality: aiProfile.nationality ?? regexProfile.nationality,
      arrivalTime: aiProfile.arrivalTime ?? regexProfile.arrivalTime,
      guestComposition: aiProfile.guestComposition ?? regexProfile.guestComposition,
      distributionPreference: aiProfile.distributionPreference ?? regexProfile.distributionPreference,
      roomAllocation: aiProfile.roomAllocation ?? regexProfile.roomAllocation,
    }
  }, [regexProfile, aiProfile])

  const triggerAIExtraction = useCallback(async () => {
    // Skip if AI is not available or already extracting
    if (!aiAvailable) return
    if (userMessages.length === 0 || isExtracting) return
    if (userMessages.length === lastExtractedCount.current) return

    setIsExtracting(true)
    try {
      const response = await fetch("/api/extract-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterances: userMessages.map((m) => m.message),
          currentProfile: regexProfile,
        }),
      })

      // 501 means AI extraction is not configured - stop trying
      if (response.status === 501) {
        console.info("AI extraction not configured, using regex-only extraction")
        lastExtractedCount.current = userMessages.length
        setAiAvailable(false)
        return
      }

      if (response.ok) {
        const data = await response.json()
        if (data.profile) {
          setAiProfile(data.profile)
          lastExtractedCount.current = userMessages.length
        }
      } else {
        // Other errors - log but don't disable AI
        console.warn("AI extraction returned error:", response.status)
      }
    } catch (error) {
      console.error("AI extraction failed:", error)
    } finally {
      // Even if extraction fails, mark current batch as processed so the UI doesn't stay blocked
      lastExtractedCount.current = userMessages.length
      setIsExtracting(false)
    }
  }, [userMessages, regexProfile, isExtracting, aiAvailable])

  // Auto-trigger AI extraction when new messages arrive (debounced)
  useEffect(() => {
    if (userMessages.length === 0) return
    if (userMessages.length === lastExtractedCount.current) return

    // When AI is not available, immediately mark messages as processed
    // so isExtractionPending resolves to false (regex-only mode works fine)
    if (!aiAvailable) {
      lastExtractedCount.current = userMessages.length
      return
    }

    const timer = setTimeout(() => {
      triggerAIExtraction()
    }, 2000) // Wait 2 seconds after last message

    return () => clearTimeout(timer)
  }, [userMessages.length, triggerAIExtraction, aiAvailable])

  const isExtractionPending = aiAvailable && (isExtracting || userMessages.length > lastExtractedCount.current)

  return { profile, userMessages, triggerAIExtraction, isExtracting, isExtractionPending, aiAvailable }
}
