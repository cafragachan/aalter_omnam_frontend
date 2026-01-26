"use client"

import { useMemo } from "react"
import { useLiveAvatarContext } from "./context"
import { MessageSender } from "./types"

type AvatarDerivedProfile = {
  name?: string
  partySize?: number
  destination?: string
  interests: string[]
}

export const useUserProfile = (): {
  profile: AvatarDerivedProfile
  userMessages: { message: string; timestamp: number }[]
} => {
  const { messages } = useLiveAvatarContext()

  const userMessages = useMemo(
    () =>
      messages
        .filter((m) => m.sender === MessageSender.USER)
        .map(({ message, timestamp }) => ({ message, timestamp })),
    [messages],
  )

  const profile = useMemo(() => {
    const result: AvatarDerivedProfile = { interests: [] }
    const interestSet = new Set<string>()

    const clean = (text: string) => text.trim().replace(/\s+/g, " ")

    userMessages.forEach(({ message }) => {
      const text = clean(message)
      const lower = text.toLowerCase()

      if (!result.name) {
        const nameMatch =
          lower.match(/\b(?:my name is|i am|i'm|this is)\s+([a-z]+(?:\s+[a-z]+)?)/i) ||
          lower.match(/\bname'?s\s+([a-z]+(?:\s+[a-z]+)?)/i)
        if (nameMatch?.[1]) {
          result.name = nameMatch[1]
        }
      }

      if (!result.partySize) {
        const partyMatch = lower.match(/(\d+)\s+(?:people|persons|guests|adults|kids|children|travel(?:ers|lers))/i)
        if (partyMatch?.[1]) {
          result.partySize = Number(partyMatch[1])
        }
      }

      if (!result.destination) {
        const destMatch =
          lower.match(/\b(?:to|for|heading to|going to|travel(?:ing)? to)\s+([a-z\s]+?)(?:[.,]|$)/i) ||
          lower.match(/\bdestination\s+(?:is|=)\s+([a-z\s]+?)(?:[.,]|$)/i)
        if (destMatch?.[1]) {
          result.destination = clean(destMatch[1])
        }
      }

      const interestMatch =
        lower.match(/\binterested in\s+([a-z\s,]+)/i) ||
        lower.match(/\blooking for\s+([a-z\s,]+)/i)
      if (interestMatch?.[1]) {
        interestMatch[1]
          .split(/,|and/i)
          .map((i) => clean(i))
          .filter(Boolean)
          .forEach((i) => interestSet.add(i))
      }
    })

    result.interests = Array.from(interestSet)
    return result
  }, [userMessages])

  return { profile, userMessages }
}

