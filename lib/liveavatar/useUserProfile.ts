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
        /(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|through|until)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?([a-zA-Z]+)/i,
      )
      // Pattern: "March 15 to March 20" or "March 15-20"
      const range2 = text.match(
        /([a-zA-Z]+)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|-|through|until)\s*(?:([a-zA-Z]+)\s*)?(\d{1,2})(?:st|nd|rd|th)?/i,
      )
      // Pattern: "from March 15 to 20" or "from the 15th to the 20th of March"
      const range3 = text.match(
        /from\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|until)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-zA-Z]+)/i,
      )
      // Pattern: "next week", "this weekend", etc.
      const relativeMatch = lower.match(/\b(next week|this weekend|next month|next weekend)\b/i)

      let start: Date | null = null
      let end: Date | null = null

      if (range1) {
        const [, d1, d2, monthName] = range1
        start = parseDate(monthName, d1)
        end = parseDate(monthName, d2)
      } else if (range2) {
        const [, m1, d1, maybeM2, d2] = range2
        const m2 = maybeM2 || m1
        start = parseDate(m1, d1)
        end = parseDate(m2, d2)
      } else if (range3) {
        const [, d1, d2, monthName] = range3
        start = parseDate(monthName, d1)
        end = parseDate(monthName, d2)
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

    // Direct interest keywords
    const interestKeywords = [
      "spa", "wellness", "relaxation", "beach", "swimming", "pool",
      "hiking", "adventure", "nature", "mountains", "skiing",
      "culture", "history", "museums", "art", "architecture",
      "food", "gastronomy", "wine", "dining", "culinary",
      "shopping", "nightlife", "entertainment",
      "golf", "tennis", "sports", "fitness",
      "family", "kids", "romantic", "honeymoon",
      "business", "conference", "meetings",
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
  })

  result.interests = Array.from(interestSet)
  return result
}

export const useUserProfile = (): {
  profile: AvatarDerivedProfile
  userMessages: { message: string; timestamp: number }[]
  triggerAIExtraction: () => Promise<void>
  isExtracting: boolean
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

    return {
      name: aiProfile.name ?? regexProfile.name,
      partySize: aiProfile.partySize ?? regexProfile.partySize,
      destination: aiProfile.destination ?? regexProfile.destination,
      startDate: aiProfile.startDate ? new Date(aiProfile.startDate) : regexProfile.startDate,
      endDate: aiProfile.endDate ? new Date(aiProfile.endDate) : regexProfile.endDate,
      interests: Array.from(mergedInterests),
      travelPurpose: aiProfile.travelPurpose ?? undefined,
      budgetRange: aiProfile.budgetRange ?? undefined,
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
      setIsExtracting(false)
    }
  }, [userMessages, regexProfile, isExtracting, aiAvailable])

  // Auto-trigger AI extraction when new messages arrive (debounced)
  useEffect(() => {
    if (!aiAvailable) return // Don't try if AI is not available
    if (userMessages.length === 0) return
    if (userMessages.length === lastExtractedCount.current) return

    const timer = setTimeout(() => {
      triggerAIExtraction()
    }, 2000) // Wait 2 seconds after last message

    return () => clearTimeout(timer)
  }, [userMessages.length, triggerAIExtraction, aiAvailable])

  return { profile, userMessages, triggerAIExtraction, isExtracting, aiAvailable }
}

