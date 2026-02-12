"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, MapPin, X } from "lucide-react"
import { SandboxLiveAvatar, DebugHud } from "@/components/liveavatar/SandboxLiveAvatar"
import { GlassPanel } from "@/components/glass-panel"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useUserProfile } from "@/lib/liveavatar"
import { JourneyStage, useUserProfileContext, type UserProfile } from "@/lib/context"
import { hotels, getHotelBySlug, getRoomsByHotelId, getAmenitiesByHotelId } from "@/lib/hotel-data"
import { useApp } from "@/lib/store"
import { useAvatarActions } from "@/lib/liveavatar/useAvatarActions"
import { useUE5WebSocket } from "@/lib/useUE5WebSocket"
import { HotelRoomCard } from "@/components/HotelRoomCard"
import { HotelAmenityCard } from "@/components/HotelAmenityCard"
import { SunToggle, type SunState } from "@/components/SunToggle"

const ProfileSync = () => {
  const { profile, isExtractionPending } = useUserProfile()
  const { profile: storedProfile, updateProfile } = useUserProfileContext()
  const lastSyncRef = useRef<string>("")

  useEffect(() => {
    // Skip if nothing extracted yet
    const hasData =
      profile.name ||
      profile.destination ||
      profile.partySize ||
      profile.startDate ||
      profile.endDate ||
      profile.interests.length > 0 ||
      profile.travelPurpose ||
      profile.budgetRange

    if (!hasData) return

    // Create a sync key to avoid duplicate updates
    const syncKey = JSON.stringify({
      name: profile.name,
      destination: profile.destination,
      partySize: profile.partySize,
      startDate: profile.startDate?.toISOString(),
      endDate: profile.endDate?.toISOString(),
      interests: profile.interests,
      travelPurpose: profile.travelPurpose,
      budgetRange: profile.budgetRange,
    })

    if (syncKey === lastSyncRef.current) return
    lastSyncRef.current = syncKey

    const [firstName, ...lastNameParts] = (profile.name ?? "").split(" ").filter(Boolean)
    const inferredLastName = lastNameParts.join(" ")

    const updates: Partial<UserProfile> = {}

    // Never override login-provided identity fields.
    if (!storedProfile.firstName && firstName) {
      updates.firstName = firstName
    }
    if (!storedProfile.lastName && inferredLastName) {
      updates.lastName = inferredLastName
    }

    if (profile.partySize != null) {
      updates.familySize = profile.partySize
    }
    if (profile.destination) {
      updates.destination = profile.destination
    }
    if (profile.startDate) {
      updates.startDate = profile.startDate
    }
    if (profile.endDate) {
      updates.endDate = profile.endDate
    }
    if (profile.interests.length > 0) {
      updates.interests = profile.interests
    }
    if (profile.travelPurpose) {
      updates.travelPurpose = profile.travelPurpose
    }
    if (profile.budgetRange) {
      updates.budgetRange = profile.budgetRange
    }

    if (Object.keys(updates).length > 0) {
      updateProfile(updates)
    }
  }, [
    profile.name,
    profile.destination,
    profile.partySize,
    profile.startDate,
    profile.endDate,
    profile.interests,
    profile.travelPurpose,
    profile.budgetRange,
    storedProfile.firstName,
    storedProfile.lastName,
    updateProfile,
  ])

  // Visual indicator when AI extraction is happening
  if (isExtractionPending) {
    return (
      <div className="fixed bottom-4 left-4 z-30 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 backdrop-blur">
        Analyzing...
      </div>
    )
  }

  return null
}

type UnitSelectionMessage = {
  type: "unit"
  roomName: string
  description?: string
  price?: string
  level?: string
}

const stageLabels: Record<JourneyStage, string> = {
  PROFILE_COLLECTION: "Profile",
  DESTINATION_SELECT: "Destinations",
  HOTEL_EXPLORATION: "Hotel Exploration",
  ROOM_BOOKING: "Room Booking",
}

const JourneyOrchestrator = ({ onHotelExploreReset }: { onHotelExploreReset: () => void }) => {
  const { journeyStage, setJourneyStage, profile } = useUserProfileContext()
  const { selectedHotel, setPreferredPanel, pendingRoomAnnouncement, setPendingRoomAnnouncement, pendingAmenityAnnouncement, setPendingAmenityAnnouncement, pendingUnitAnnouncement, setPendingUnitAnnouncement, setPendingUnitAction } = useApp()
  const { repeat, interrupt } = useAvatarActions("FULL")
  // Use derived profile directly to avoid lag between AI extraction and context sync
  const { profile: derivedProfile, isExtractionPending, userMessages } = useUserProfile()
  const lastPromptKey = useRef<string>("")
  const awaitingHotelIntent = useRef(false)
  const awaitingRoomViewIntent = useRef(false)
  const lastNavHandledMessageCount = useRef(0)
  const lastHandledMessageCount = useRef(0)
  const lastHotelResetHandledMessageCount = useRef(0)

  // Ready to show destinations when we have: dates, guests, and interests
  // Note: destination is NOT required here - the overlay helps them pick one
  const readyForDestinations =
    Boolean(derivedProfile.partySize) &&
    Boolean(derivedProfile.startDate && derivedProfile.endDate) &&
    derivedProfile.interests.length > 0

  // Drive prompts for missing data during profile collection
  useEffect(() => {
    if (journeyStage !== "PROFILE_COLLECTION") return
    // Wait for AI extraction to complete before prompting - prevents choppy interruptions
    // when user answers multiple questions at once
    if (isExtractionPending) return

    const missingDates = !derivedProfile.startDate || !derivedProfile.endDate
    const missingGuests = !derivedProfile.partySize
    const missingInterests = derivedProfile.interests.length === 0

    const key = `profile-${missingDates}-${missingGuests}-${missingInterests}`
    if (lastPromptKey.current === key) return
    lastPromptKey.current = key

    const firstName = profile.firstName?.trim() || "there"

    // First, ask for travel dates and party size
    if (missingDates && missingGuests) {
      interrupt()
      repeat(
        `${firstName}, to find the perfect property for you, I need to know: when are you planning to travel and how many guests will be joining you?`,
      ).catch(() => undefined)
      return
    }
    else if (missingDates) {
      interrupt()
      repeat(
        `${firstName}, could you please confirm: when are you planning to travel?`,
      ).catch(() => undefined)
      return
    }
    else if (missingGuests) {
      interrupt()
      repeat(
        `${firstName}, I'd also need to know: how many guests will be joining you?`,
      ).catch(() => undefined)
      return
    }

    // Then ask for interests to help recommend destinations
    if (missingInterests) {
      interrupt()
      repeat(
        `Perfect! Now tell me, what kind of experiences are you looking for?`,
      ).catch(() => undefined)
      return
    }
  }, [
    interrupt,
    isExtractionPending,
    journeyStage,
    derivedProfile.endDate,
    derivedProfile.partySize,
    profile.firstName,
    derivedProfile.interests.length,
    derivedProfile.startDate,
    repeat,
  ])

  // Advance to destination selection when we have enough context
  useEffect(() => {
    // Wait for extraction to complete before advancing stage
    if (isExtractionPending) return
    if (journeyStage === "PROFILE_COLLECTION" && readyForDestinations) {
      setJourneyStage("DESTINATION_SELECT")
      // // interrupt()?.catch(() => undefined)
      // repeat(
      //   "Wonderful! Based on your preferences, let me show you some available options I think you'll love.",
      // ).catch(() => undefined)
    }
  }, [readyForDestinations, journeyStage, isExtractionPending, interrupt, repeat, setJourneyStage])

  // Prompt when destinations overlay is shown
  useEffect(() => {
    if (journeyStage !== "DESTINATION_SELECT") return
    if (lastPromptKey.current === "destinations-shown") return
    lastPromptKey.current = "destinations-shown"
    // Small delay to let the overlay render
    interrupt()
    const timer = setTimeout(() => {
      repeat("Wonderful! Based on your preferences, let me show you some available options I think you'll love. Take a look at these properties. Tap any card to explore the digital twin.").catch(
        () => undefined,
      )
    }, 500)
    return () => clearTimeout(timer)
  }, [journeyStage, repeat])

  // Congratulatory prompt when a hotel is picked
  useEffect(() => {
    if (journeyStage !== "HOTEL_EXPLORATION") return
    if (!selectedHotel) return

    const hotel = hotels.find((h) => h.slug === selectedHotel)
    const key = `hotel-${selectedHotel}`
    if (lastPromptKey.current === key) return
    lastPromptKey.current = key

    const hotelName = hotel?.name ?? "this property"
    const locationText = hotel?.location ? ` in ${hotel.location}` : ""
    const description =
      hotel?.description ?? "delivers a memorable stay with thoughtful design and service"
    const narrative = `${description.charAt(0).toLowerCase()}${description.slice(1)}`

    interrupt()
    repeat(
      `Great choice—the ${hotelName} is a fantastic hotel that ${narrative}. Would you like to explore available rooms, check out the hotel amenities, or get a feel for the surrounding area?`,
    ).catch(() => undefined)

    awaitingHotelIntent.current = true
    lastHandledMessageCount.current = userMessages.length
  }, [journeyStage, selectedHotel, interrupt, repeat, userMessages.length])

  // Listen for the user's intent (rooms vs amenities vs location) after the question
  useEffect(() => {
    if (!awaitingHotelIntent.current) return
    if (userMessages.length <= lastHandledMessageCount.current) return

    const latestMessage = userMessages[userMessages.length - 1]?.message?.toLowerCase() ?? ""
    lastHandledMessageCount.current = userMessages.length

    const wantsRooms = /\b(room|rooms|suite|suites|book|stay|bed|accommodation)\b/.test(latestMessage)
    const wantsAmenities = /\b(amenity|amenities|spa|pool|gym|restaurant|bar|facility|facilities)\b/.test(latestMessage)
    const wantsLocation = /\b(location|surrounding|surroundings|area|neighbou?rhood|outside|around|nearby|map|walk)\b/.test(latestMessage)

    if (wantsRooms && !wantsAmenities && !wantsLocation) {
      awaitingHotelIntent.current = false
      interrupt()
      repeat("Perfect, I'll pull up the available rooms for you now.").catch(() => undefined)
      setPreferredPanel("rooms")
      return
    }

    if (wantsAmenities && !wantsRooms && !wantsLocation) {
      awaitingHotelIntent.current = false
      interrupt()
      repeat("Of course. Let me show you the amenities available at this property.").catch(() => undefined)
      setPreferredPanel("amenities")
      return
    }

    if (wantsLocation && !wantsRooms && !wantsAmenities) {
      awaitingHotelIntent.current = false
      interrupt()
      repeat("Absolutely. I'll show you the surrounding area and location context.").catch(() => undefined)
      setPreferredPanel("location")
      return
    }

    // Ambiguous response: acknowledge and gently re-ask
    interrupt()
    repeat("Got it. Would you like to explore rooms, check out the hotel amenities, or see the surrounding area?").catch(() => undefined)
  }, [userMessages, repeat, interrupt, setPreferredPanel])

  // Allow navigation between rooms / amenities / location at any time during hotel exploration
  useEffect(() => {
    if (journeyStage !== "HOTEL_EXPLORATION") return
    if (userMessages.length <= lastNavHandledMessageCount.current) return

    const latestMessage = userMessages[userMessages.length - 1]?.message?.toLowerCase() ?? ""
    lastNavHandledMessageCount.current = userMessages.length

    // Skip if user is currently deciding interior/exterior/back for a specific unit
    if (awaitingRoomViewIntent.current) return

    const wantsRooms = /\b(room|rooms|suite|suites|book|stay|bed|accommodation)\b/.test(latestMessage)
    const wantsAmenities = /\b(amenity|amenities|spa|pool|gym|restaurant|bar|facility|facilities)\b/.test(latestMessage)
    const wantsLocation = /\b(location|surrounding|surroundings|area|neighbou?rhood|outside|around|nearby|map|walk)\b/.test(latestMessage)

    if (wantsRooms && !wantsAmenities && !wantsLocation) {
      interrupt()
      repeat("Loading the available rooms for you now.").catch(() => undefined)
      setPreferredPanel("rooms")
      return
    }

    if (wantsAmenities && !wantsRooms && !wantsLocation) {
      interrupt()
      repeat("Sure, opening the amenities for this property.").catch(() => undefined)
      setPreferredPanel("amenities")
      return
    }

    if (wantsLocation && !wantsRooms && !wantsAmenities) {
      interrupt()
      repeat("Taking you to the surrounding area and location view.").catch(() => undefined)
      setPreferredPanel("location")
      return
    }
  }, [journeyStage, userMessages, interrupt, repeat, setPreferredPanel])

  // Listen for "go back" or "explore the hotel" requests during hotel exploration
  useEffect(() => {
    if (journeyStage !== "HOTEL_EXPLORATION") return
    if (userMessages.length <= lastHotelResetHandledMessageCount.current) return

    const latestMessage = userMessages[userMessages.length - 1]?.message?.toLowerCase() ?? ""
    lastHotelResetHandledMessageCount.current = userMessages.length

    const wantsBack = /\b(back|go back|return|go to hotel|back to hotel)\b/.test(latestMessage)
    const wantsHotelExplore =
      /\b(explore|tour|see|show|walk around|look around|view)\b.*\bhotel\b/.test(latestMessage) ||
      /\bhotel\b.*\b(explore|tour|see|show|walk around|look around|view)\b/.test(latestMessage) ||
      /\bhotel view\b/.test(latestMessage)

    if (awaitingRoomViewIntent.current && wantsBack) return

    if (wantsBack || wantsHotelExplore) {
      onHotelExploreReset()
    }
  }, [journeyStage, userMessages, onHotelExploreReset])

  // Handle room selection announcement (from UI room cards)
  useEffect(() => {
    if (!pendingRoomAnnouncement) return

    const { roomName, occupancy } = pendingRoomAnnouncement
    setPendingRoomAnnouncement(null)

    interrupt()
    repeat(
      `The ${roomName} can host up to ${occupancy} guests. Please select one of our available rooms at the highlighted locations`
    ).catch(() => undefined)

    awaitingRoomViewIntent.current = true
    lastHandledMessageCount.current = userMessages.length
  }, [pendingRoomAnnouncement, setPendingRoomAnnouncement, interrupt, repeat, userMessages.length])

  // Handle unit selection announcement (from UE5 experience)
  useEffect(() => {
    if (!pendingUnitAnnouncement) return

    const { roomName } = pendingUnitAnnouncement
    setPendingUnitAnnouncement(null)

    interrupt()
    repeat(
      `Lovely pick! The ${roomName} is an excellent choice. Would you like to explore the interior or the exterior view of this room?`
    ).catch(() => undefined)

    awaitingRoomViewIntent.current = true
    lastHandledMessageCount.current = userMessages.length
  }, [pendingUnitAnnouncement, setPendingUnitAnnouncement, interrupt, repeat, userMessages.length])

  const buildAmenityNarrative = useCallback((amenity: { name: string; scene: string }) => {
    const normalizedScene = amenity.scene.toLowerCase()
    const normalizedName = amenity.name.toLowerCase()
    if (normalizedScene.includes("lobby") || normalizedName.includes("lobby")) {
      return "we'll step into a grand, light-filled arrival lounge with plush seating and a calm lakeside energy."
    }
    if (normalizedScene.includes("conference") || normalizedName.includes("conference")) {
      return "this conference space is set up for focused meetings with modern tech, warm lighting, and quiet service."
    }
    return "it's one of the property's signature spaces, designed for comfort, flow, and a touch of quiet luxury."
  }, [])

  // Handle amenity selection announcement (from UI amenity cards)
  useEffect(() => {
    if (!pendingAmenityAnnouncement) return

    const { name, scene } = pendingAmenityAnnouncement
    setPendingAmenityAnnouncement(null)

    const narrative = buildAmenityNarrative({ name, scene })
    interrupt()
    repeat(`Perfect, let me take you to the ${name}, ${narrative}`).catch(() => undefined)
  }, [pendingAmenityAnnouncement, setPendingAmenityAnnouncement, buildAmenityNarrative, interrupt, repeat])

  // Listen for the user's intent (interior vs exterior vs back) after room selection
  useEffect(() => {
    if (!awaitingRoomViewIntent.current) return
    if (userMessages.length <= lastHandledMessageCount.current) return

    const latestMessage = userMessages[userMessages.length - 1]?.message?.toLowerCase() ?? ""
    lastHandledMessageCount.current = userMessages.length

    const wantsInterior = /\b(interior|inside|indoor|in)\b/.test(latestMessage)
    const wantsExterior = /\b(exterior|outside|outdoor|out|view)\b/.test(latestMessage)
    const wantsBack = /\b(back|return|cancel|nevermind|never mind|go back)\b/.test(latestMessage)

    if (wantsBack) {
      awaitingRoomViewIntent.current = false
      interrupt()
      repeat("No problem, taking you back to the hotel view.").catch(() => undefined)
      setPendingUnitAction("back")
      return
    }

    if (wantsInterior && !wantsExterior) {
      interrupt()
      repeat("Ok, Let me show you the interior of this room.").catch(() => undefined)
      setPendingUnitAction("interior")
      return
    }

    if (wantsExterior && !wantsInterior) {
      interrupt()
      repeat("Perfect! Here's the exterior view of this room.").catch(() => undefined)
      setPendingUnitAction("exterior")
      return
    }

    // Ambiguous response: acknowledge and gently re-ask
    interrupt()
    repeat("I didn't catch that. Would you like to explore the room interior, the exterior view, or go back?").catch(() => undefined)
  }, [userMessages, repeat, interrupt, setPendingUnitAction])

  return null
}

export default function HomePage() {
  const { selectHotel, selectedHotel, preferredPanel, setPreferredPanel, setPendingRoomAnnouncement, setPendingUnitAnnouncement, setPendingAmenityAnnouncement, pendingUnitAction, setPendingUnitAction } = useApp()
  const { profile, journeyStage, setJourneyStage, updateProfile } = useUserProfileContext()
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamUrl = process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
  const hasStream = streamUrl !== "about:blank"
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)
  const [showAmenitiesPanel, setShowAmenitiesPanel] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState<UnitSelectionMessage | null>(null)
  const [unitViewTab, setUnitViewTab] = useState<"interior" | "exterior" | "">(``)
  const [showUe5FadeOverlay, setShowUe5FadeOverlay] = useState(false)
  const [isUe5FadeOpaque, setIsUe5FadeOpaque] = useState(false)
  const [sunState, setSunState] = useState<SunState>("daylight")
  const ue5FadeTimeoutsRef = useRef<number[]>([])

  // UE5 WebSocket message handler - memoized to prevent reconnection loops
  const handleUE5Message = useCallback((msg: import("@/lib/useUE5WebSocket").UE5IncomingMessage) => {
    console.log("UE5 message received:", msg)
  }, [])

  // Ref to hold the latest setPendingUnitAnnouncement to avoid dependency issues
  const setPendingUnitAnnouncementRef = useRef(setPendingUnitAnnouncement)
  useEffect(() => {
    setPendingUnitAnnouncementRef.current = setPendingUnitAnnouncement
  }, [setPendingUnitAnnouncement])

  // Handle unit selection from UE5 experience
  const handleUnitSelected = useCallback((unit: UnitSelectionMessage) => {
    setSelectedUnit(unit)
    setUnitViewTab("")
    setShowRoomsPanel(false)
    setShowAmenitiesPanel(false)
    // Trigger avatar announcement for the selected unit
    setPendingUnitAnnouncementRef.current({ roomName: unit.roomName })
  }, [])

  // UE5 WebSocket connection (single instance via hook to avoid multiple sockets)
  const { isConnected, sendStartTest, sendRawMessage } = useUE5WebSocket({
    onMessage: handleUE5Message,
    onUnitSelected: handleUnitSelected,
  })

  const handleSendMessage = useCallback((type: string, value: unknown) => {
    sendRawMessage({ type, value })
  }, [sendRawMessage])

  const handleHotelExploreReset = useCallback(() => {
    handleSendMessage("gameEstate", "default")
  }, [handleSendMessage])

  const selectedHotelData = useMemo(
    () => (selectedHotel ? getHotelBySlug(selectedHotel) : undefined),
    [selectedHotel],
  )

  const rooms = useMemo(
    () => (selectedHotelData ? getRoomsByHotelId(selectedHotelData.id) : []),
    [selectedHotelData],
  )

  const amenities = useMemo(
    () => (selectedHotelData ? getAmenitiesByHotelId(selectedHotelData.id) : []),
    [selectedHotelData],
  )

  const handleRoomsPanel = useCallback(() => {
    handleSendMessage("gameEstate", "rooms")
    setShowRoomsPanel(true)
    setShowAmenitiesPanel(false)
  }, [handleSendMessage])

  const handleAmenitiesPanel = useCallback(() => {
    handleSendMessage("gameEstate", "amenities")
    setShowAmenitiesPanel(true)
    setShowRoomsPanel(false)
  }, [handleSendMessage])

  const handleLocationView = useCallback(() => {
    handleSendMessage("gameEstate", "location")
    setShowRoomsPanel(false)
    setShowAmenitiesPanel(false)
  }, [handleSendMessage])

  const closeRoomsPanel = useCallback((sendDefault = true) => {
    setShowRoomsPanel(false)
    if (sendDefault) {
      handleSendMessage("gameEstate", "default")
    }
  }, [handleSendMessage])

  const closeAmenitiesPanel = useCallback((sendDefault = true) => {
    setShowAmenitiesPanel(false)
    if (sendDefault) {
      handleSendMessage("gameEstate", "default")
    }
  }, [handleSendMessage])

  const clearUe5FadeTimeouts = useCallback(() => {
    ue5FadeTimeoutsRef.current.forEach((id) => window.clearTimeout(id))
    ue5FadeTimeoutsRef.current = []
  }, [])

  const runUe5FadeTransition = useCallback(() => {
    clearUe5FadeTimeouts()
    setIsUe5FadeOpaque(false)
    setShowUe5FadeOverlay(true)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setIsUe5FadeOpaque(true)
      })
    })

    const midpointTimeout = window.setTimeout(() => {
      setIsUe5FadeOpaque(false)
    }, 2000)

    const endTimeout = window.setTimeout(() => {
      setShowUe5FadeOverlay(false)
    }, 3000)

    ue5FadeTimeoutsRef.current = [midpointTimeout, endTimeout]
  }, [clearUe5FadeTimeouts])

  useEffect(() => {
    return () => {
      clearUe5FadeTimeouts()
    }
  }, [clearUe5FadeTimeouts])

  const handleSelectRoom = useCallback((room: import("@/lib/hotel-data").Room) => {
    handleSendMessage("selectedRoom", room.id)
    closeRoomsPanel(false)
    setPendingRoomAnnouncement({ roomName: room.name, occupancy: room.occupancy })
  }, [handleSendMessage, closeRoomsPanel, setPendingRoomAnnouncement])

  const handleSelectAmenity = useCallback((amenity: import("@/lib/hotel-data").Amenity) => {
    setPendingAmenityAnnouncement({ name: amenity.name, scene: amenity.scene })
    handleSendMessage("communal", amenity.id)
    closeAmenitiesPanel(false)
    runUe5FadeTransition()
  }, [closeAmenitiesPanel, handleSendMessage, runUe5FadeTransition, setPendingAmenityAnnouncement])

  const handleUnitViewChange = useCallback((value: "interior" | "exterior") => {
    setUnitViewTab(value)
    handleSendMessage("unitView", value)
  }, [handleSendMessage])

  const handleUnitBack = useCallback(() => {
    setSelectedUnit(null)
    setUnitViewTab("")
    handleSendMessage("gameEstate", "default")
  }, [handleSendMessage])

  const handleSunStateChange = useCallback((value: SunState) => {
    setSunState(value)
    handleSendMessage("sunPosition", value)
  }, [handleSendMessage])

  useEffect(() => {
    if (!selectedHotel) return
    setSunState("daylight")
    handleSendMessage("sunPosition", "daylight")
  }, [selectedHotel, handleSendMessage])

  // Handle pending unit action from JourneyOrchestrator
  useEffect(() => {
    if (!pendingUnitAction) return

    if (pendingUnitAction === "interior") {
      handleUnitViewChange("interior")
      runUe5FadeTransition()
    } else if (pendingUnitAction === "exterior") {
      handleUnitViewChange("exterior")
    } else if (pendingUnitAction === "back") {
      handleUnitBack()
      runUe5FadeTransition()
    }
    // Clear the action AFTER calling handlers to ensure they execute
    setPendingUnitAction(null)
  }, [pendingUnitAction, setPendingUnitAction, handleUnitViewChange, handleUnitBack, runUe5FadeTransition])

  // Open the requested panel when set by the journey orchestrator
  useEffect(() => {
    if (!preferredPanel) return
    if (preferredPanel === "rooms") {
      handleRoomsPanel()
    } else if (preferredPanel === "amenities") {
      handleAmenitiesPanel()
    } else if (preferredPanel === "location") {
      handleLocationView()
    }
    setPreferredPanel(null)
  }, [preferredPanel, handleRoomsPanel, handleAmenitiesPanel, handleLocationView, setPreferredPanel])

  // Ready for destination selection when we have basic info + travel context
  // Note: destination is selected via the overlay, not collected beforehand
  const readyForDestinationSelect = useMemo(
    () =>
      Boolean(
        profile.firstName &&
        profile.email &&
        profile.familySize &&
        profile.startDate &&
        profile.endDate &&
        profile.interests.length > 0,
      ),
    [
      profile.email,
      profile.familySize,
      profile.firstName,
      profile.interests.length,
      profile.startDate,
      profile.endDate,
    ],
  )

  useEffect(() => {
    if (journeyStage === "PROFILE_COLLECTION" && readyForDestinationSelect) {
      setJourneyStage("DESTINATION_SELECT")
    }
  }, [journeyStage, readyForDestinationSelect, setJourneyStage])

  useEffect(() => {
    const startSandboxSession = async () => {
      try {
        const res = await fetch("/api/start-sandbox-session", { method: "POST" })
        if (!res.ok) {
          const resp = await res.json().catch(() => ({}))
          throw new Error(resp?.error ?? "Failed to start sandbox session")
        }
        const { session_token } = await res.json()
        setSessionToken(session_token)
      } catch (err) {
        setError((err as Error).message)
      }
    }

    startSandboxSession()
  }, [])

  const handleSelectHotel = (slug: string) => {
    const hotel = hotels.find((h) => h.slug === slug)

    // Update profile with selected destination
    if (hotel) {
      updateProfile({ destination: hotel.location })
    }

    selectHotel(slug)
    setPreferredPanel(null)
    setJourneyStage("HOTEL_EXPLORATION")

    //sendStartTest(slug)

    handleSendMessage("startTEST", "startTEST")

    // if (slug === "edition-lake-como") {
    //   router.push("/metaverse")
    //   return
    // }
    // router.push(`/hotel/${slug}`)
  }

  const showDestinationsOverlay = journeyStage === "DESTINATION_SELECT"

  const formatUnitPrice = (price?: string) => {
    if (!price) return "N/A"

    const parsed = Number(price)
    if (Number.isFinite(parsed)) {
      return `$${parsed.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    }

    return price
  }

  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden">
      {hasStream ? (
        <iframe
          title="Vagon UE5 Stream"
          src={streamUrl}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 via-black to-slate-950 text-white/70">
          Set NEXT_PUBLIC_VAGON_STREAM_URL to render the live UE5 background here.
        </div>
      )}
      {showUe5FadeOverlay && (
        <div
          className={`pointer-events-none absolute inset-0 z-[5] bg-black transition-opacity duration-1000 ease-linear ${isUe5FadeOpaque ? "opacity-100" : "opacity-0"}`}
        />
      )}
      {selectedHotel && journeyStage === "HOTEL_EXPLORATION" && (
        <SunToggle
          value={sunState}
          onChange={handleSunStateChange}
          className="pointer-events-auto fixed left-1/2 top-1 z-20 -translate-x-1/2"
        />
      )}

      {selectedUnit && (
        <div className="pointer-events-none fixed right-6 top-1/2 z-20 -translate-y-1/2">
          <GlassPanel className="pointer-events-auto w-[360px] space-y-4 border border-white/15 bg-white/12 px-7 py-6 text-white shadow-2xl shadow-black/40 backdrop-blur-2xl">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">Unit Selected</div>
              <div className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs text-white/80">
                Level {selectedUnit.level ?? "N/A"}
              </div>
            </div>
            <div>
              <h3 className="text-xl font-semibold uppercase tracking-[0.2em]">{selectedUnit.roomName}</h3>
              <p className="mt-1 text-lg font-semibold text-white/80">{formatUnitPrice(selectedUnit.price)} /night</p>
            </div>
            <p className="text-xs leading-relaxed text-white/70">
              {selectedUnit.description?.trim() || "No description provided for this unit."}
            </p>
          </GlassPanel>
        </div>
      )}

      <div className="pointer-events-none relative z-10 flex min-h-screen flex-col justify-between px-6 pb-10 pt-12 sm:px-10">
        <div className="flex items-start justify-between text-white/80">
          <div className="flex items-center gap-3">
            <div className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs uppercase tracking-[0.2em]">
              Journey: {stageLabels[journeyStage]}
            </div>
            <div
              className={`h-2 w-2 rounded-full ${isConnected ? "bg-green-400" : "bg-red-400"}`}
              title={isConnected ? "UE5 Connected" : "UE5 Disconnected"}
            />
          </div>
          {journeyStage === "PROFILE_COLLECTION" && (
            <div className="text-xs text-white/70">Share your travel details to see destinations</div>
          )}
        </div>

        <div className="mt-auto grid gap-6 md:grid-cols-[420px,1fr] md:items-end">
          <div className="pointer-events-auto w-full max-w-[460px]">
            <div
              className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/70 shadow-2xl backdrop-blur"
              style={{ aspectRatio: "1 / 1.25" }}
            >
              {error && (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-300">
                  {error}
                </div>
              )}

              {!error && !sessionToken && (
                <div className="flex h-full items-center justify-center text-white/80">Launching sandbox avatar...</div>
              )}

              {sessionToken && (
                <SandboxLiveAvatar
                  sessionToken={sessionToken}
                  fit="cover"
                  renderHud={
                    <div className="fixed top-4 right-4 z-30 space-y-3 pointer-events-none">
                      <DebugHud />
                      <ProfileSync />
                      <JourneyOrchestrator onHotelExploreReset={handleHotelExploreReset} />
                    </div>
                  }
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {showDestinationsOverlay && (
        <div className="fixed inset-0 z-20 flex items-center justify-center px-4 py-10 pointer-events-none">
          <GlassPanel className="relative z-10 w-full max-w-5xl space-y-6 px-8 py-10 pointer-events-auto">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/10"
                onClick={() => setJourneyStage("PROFILE_COLLECTION")}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
                <MapPin className="h-4 w-4" />
                Explore Digital Twins
              </div>
              <div className="ml-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white hover:bg-white/10"
                  onClick={() => setJourneyStage("PROFILE_COLLECTION")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <h1 className="text-3xl font-semibold text-white">Destinations</h1>

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {hotels.map((hotel) => (
                <Card
                  key={hotel.id}
                  className={`group overflow-hidden border-white/20 bg-white/12 backdrop-blur-xl transition-all ${hotel.active
                    ? "cursor-pointer hover:bg-white/18 hover:shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)]"
                    : "cursor-not-allowed opacity-50 grayscale"
                    }`}
                  onClick={() => {
                    if (hotel.active) {
                      handleSelectHotel(hotel.slug)
                    }
                  }}
                >
                  <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
                    <img
                      src={hotel.image}
                      alt={hotel.name}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <div className="absolute inset-0 bg-black/30" />
                    <div className="relative flex h-full items-center justify-center p-6 text-center">
                      <h3 className="text-xl font-bold text-white transition-transform group-hover:scale-105">
                        {hotel.name}
                      </h3>
                    </div>
                  </div>
                  <div className="p-4">
                    <p className="text-sm text-white/70">{hotel.location}</p>
                    <p className="mt-1 text-xs text-white/50">{hotel.description}</p>
                  </div>
                </Card>
              ))}
            </div>
          </GlassPanel>
        </div>
      )}

      {showRoomsPanel && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => closeRoomsPanel(true)}
        >
          <div className="w-full max-w-6xl px-4" onClick={(event) => event.stopPropagation()}>
            <GlassPanel className="bg-white/12 px-8 py-10 backdrop-blur-2xl">
              <div className="mb-6 flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white hover:bg-white/10"
                  onClick={() => closeRoomsPanel(true)}
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Rooms</p>
                  <h2 className="text-2xl font-semibold text-white">{selectedHotelData?.name || "Rooms"}</h2>
                </div>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,320px))] justify-center gap-6">
                {rooms.length > 0 ? (
                  rooms.map((room) => (
                    <HotelRoomCard
                      key={room.id}
                      room={room}
                      onClick={() => handleSelectRoom(room)}
                    />
                  ))
                ) : (
                  <p className="text-white/70">No rooms available for this property.</p>
                )}
              </div>
            </GlassPanel>
          </div>
        </div>
      )}

      {showAmenitiesPanel && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => closeAmenitiesPanel(true)}
        >
          <div className="w-full max-w-5xl px-4" onClick={(event) => event.stopPropagation()}>
            <GlassPanel className="bg-white/12 px-8 py-10 backdrop-blur-2xl">
              <div className="mb-6 flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white hover:bg-white/10"
                  onClick={() => closeAmenitiesPanel(true)}
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Amenities</p>
                  <h2 className="text-2xl font-semibold text-white">{selectedHotelData?.name || "Amenities"}</h2>
                </div>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,320px))] justify-center gap-6">
                {amenities.length > 0 ? (
                  amenities.map((amenity) => (
                    <HotelAmenityCard
                      key={amenity.id}
                      amenity={amenity}
                      onClick={() => handleSelectAmenity(amenity)}
                    />
                  ))
                ) : (
                  <p className="text-white/70">No amenities available for this property.</p>
                )}
              </div>
            </GlassPanel>
          </div>
        </div>
      )}
    </div>
  )
}

