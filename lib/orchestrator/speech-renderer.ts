// ---------------------------------------------------------------------------
// Speech renderer — Phase 7 Pass (a) structured speech for SPEAK_INTENT.
//
// Pure function, no React, no I/O. Given a SpeechKey + args, return the
// identical string the legacy SPEAK push would have carried. The executor
// calls this only as a fallback: when the orchestrator preGenerated speech
// is present, that string wins.
//
// Keep this file in lockstep with the SPEAK_INTENT push sites in
// journey-machine.ts — adding a new key here must pair with the reducer
// emitting it, and vice versa.
// ---------------------------------------------------------------------------

import type { AmenityRef, JourneyState, SpeechArgs, SpeechKey } from "./types"
import { DEFAULT_SPEECH, buildAmenityListingSpeech } from "./journey-machine"
import { getReengagePrompt } from "./reengage-prompts"

export function renderSpeech(key: SpeechKey, args?: SpeechArgs): string {
  switch (key) {
    // ---- Static keys (direct DEFAULT_SPEECH lookup) --------------------
    case "downloadData":
      return DEFAULT_SPEECH.downloadData
    case "loungeConfirm":
      return DEFAULT_SPEECH.loungeConfirm
    case "endConfirm":
      return DEFAULT_SPEECH.endConfirm
    case "endFarewell":
      return DEFAULT_SPEECH.endFarewell
    case "endCancel":
      return DEFAULT_SPEECH.endCancel
    case "loungeWelcomeBack":
      return DEFAULT_SPEECH.loungeWelcomeBack
    case "loungeCancel":
      return DEFAULT_SPEECH.loungeCancel
    case "profileReadyWelcome":
      return DEFAULT_SPEECH.profileReadyWelcome
    case "loungeExploreAck":
      return DEFAULT_SPEECH.loungeExploreAck
    case "loungeToHotelIntro":
      return DEFAULT_SPEECH.loungeToHotelIntro
    case "hotelWelcome":
      return DEFAULT_SPEECH.hotelWelcome
    case "hotelIntroShort":
      return DEFAULT_SPEECH.hotelIntroShort
    case "pullUpRooms":
      return DEFAULT_SPEECH.pullUpRooms
    case "amenitiesAskWhich":
      return DEFAULT_SPEECH.amenitiesAskWhich
    case "showLocation":
      return DEFAULT_SPEECH.showLocation
    case "bookPickRoom":
      return DEFAULT_SPEECH.bookPickRoom
    case "otherOptionsRooms":
      return DEFAULT_SPEECH.otherOptionsRooms
    case "hotelBackOverview":
      return DEFAULT_SPEECH.hotelBackOverview
    case "unknownResponse":
      return DEFAULT_SPEECH.unknownResponse
    case "openingBookingPage":
      return DEFAULT_SPEECH.openingBookingPage
    case "tapGreenUnitFirst":
      return DEFAULT_SPEECH.tapGreenUnitFirst
    case "steppingInside":
      return DEFAULT_SPEECH.steppingInside
    case "exteriorView":
      return DEFAULT_SPEECH.exteriorView
    case "backToOtherRooms":
      return DEFAULT_SPEECH.backToOtherRooms
    case "backToHotelOverview":
      return DEFAULT_SPEECH.backToHotelOverview
    case "amenityBackToHotel":
      return DEFAULT_SPEECH.amenityBackToHotel
    case "amenityFallbackPrompt":
      return DEFAULT_SPEECH.amenityFallbackPrompt
    case "amenityNextNoWorries":
      return DEFAULT_SPEECH.amenityNextNoWorries
    case "amenityAskBack":
      return DEFAULT_SPEECH.amenityAskBack
    case "amenityBookNudge":
      return DEFAULT_SPEECH.amenityBookNudge
    case "amenityPickRooms":
      return DEFAULT_SPEECH.amenityPickRooms
    case "unitExploreDeclined":
      return DEFAULT_SPEECH.unitExploreDeclined
    case "unitDeclineClarify":
      return DEFAULT_SPEECH.unitDeclineClarify
    case "lightingAskWhich":
      return DEFAULT_SPEECH.lightingAskWhich

    // ---- Templated keys ------------------------------------------------
    case "destinationPicked":
      return DEFAULT_SPEECH.destinationPicked(String(args?.hotelName ?? ""))

    case "lightingSet": {
      const mode = args?.mode
      const safeMode: "daylight" | "sunset" | "night" =
        mode === "sunset" || mode === "night" ? mode : "daylight"
      return DEFAULT_SPEECH.lightingSet(safeMode)
    }

    case "unitPicked":
      return DEFAULT_SPEECH.unitPicked(String(args?.roomName ?? ""))

    case "amenitySuggestFallback":
      return DEFAULT_SPEECH.amenitySuggestFallback(String(args?.suggestedNext ?? ""))

    case "amenityNavigate": {
      const amenityName = String(args?.amenityName ?? "")
      const narrative = String(args?.narrative ?? "")
      const teaser = String(args?.teaser ?? "")
      return `Let me take you to the ${amenityName} — ${narrative}${teaser}`
    }

    case "amenityListing": {
      const allAmenities = (args?.allAmenities as AmenityRef[] | undefined) ?? []
      const visitedAmenities = (args?.visitedAmenities as string[] | undefined) ?? []
      const travelPurpose = args?.travelPurpose as string | undefined
      const recommendedAmenityName = args?.recommendedAmenityName as string | undefined
      return buildAmenityListingSpeech(
        allAmenities,
        visitedAmenities,
        travelPurpose,
        recommendedAmenityName,
      ).text
    }

    case "reengage":
      return getReengagePrompt(args?.state as JourneyState)

    case "literal":
      return String(args?.text ?? "")
  }
}
