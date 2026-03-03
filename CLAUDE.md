# Omnam Metaverse Frontend — Project Context

## What This Is

A **Next.js 16** web app for booking luxury hotel experiences through an AI-powered conversational avatar (HeyGen LiveAvatar) with real-time 3D visualization via **Unreal Engine 5** pixel streaming (hosted on Vagon.io, connected locally via WebSocket during development).

The user talks to an AI avatar concierge (Ava) who guides them through a multi-stage booking journey: collecting travel preferences → selecting a destination → exploring a hotel's digital twin in UE5 → picking a room.

## Tech Stack

- **Framework**: Next.js 16 (App Router) + React 19 + TypeScript
- **Styling**: Tailwind CSS v4, glassmorphism design system
- **AI Avatar**: HeyGen LiveAvatar SDK (`@heygen/liveavatar-web-sdk`) — voice chat, TTS, green-screen chroma-key canvas rendering
- **3D Backend**: UE5 pixel stream via iframe + WebSocket signalling on `ws://localhost:7788`
- **NLP**: OpenAI `gpt-4o-mini` for profile extraction (optional, falls back to regex)
- **UI Components**: shadcn/ui library in `components/ui/`

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│              HomePage (app/home/page.tsx)        │
│   Session init → LiveAvatarContextProvider      │
│   └─ HomePageContent (thin layout shell)        │
└──────┬──────────────────────────┬───────────────┘
       │                          │
┌──────▼──────┐          ┌────────▼────────┐
│  EventBus   │◄────────►│ useJourney()    │
│  (pub/sub)  │          │ (state machine) │
│ lib/events  │          │ lib/orchestrator│
└──────┬──────┘          └────────┬────────┘
       │                          │
┌──────▼──────┐          ┌────────▼────────┐
│ UE5 Bridge  │          │ IntentClassifier│
│ lib/ue5/    │          │ lib/orchestrator│
│ bridge.ts   │          │ /intents.ts     │
└─────────────┘          └─────────────────┘
```

### Data Flow

1. **User speaks** → HeyGen transcribes → messages stored in `LiveAvatarContext`
2. **useUserProfile** extracts structured data (regex + optional AI) → `AvatarDerivedProfile`
3. **ProfileSync** syncs extracted data → `UserProfileContext` (global state)
4. **useJourney** watches profile + messages → runs through `journeyReducer` (pure state machine) → produces effects
5. **Effects** execute: avatar speaks (`repeat()`), UE5 commands sent, UI panels open/close, fade transitions
6. **UI panels** emit events via **EventBus** (e.g., `ROOM_CARD_TAPPED`) → consumed by `useJourney`

### Journey Stages

```
PROFILE_COLLECTION → DESTINATION_SELECT → HOTEL_EXPLORATION → ROOM_BOOKING
    (dates, guests,     (hotel grid          (rooms/amenities/     (TBD)
     interests)          overlay)             location panels,
                                              UE5 navigation)
```

## Key Directory Structure

```
app/
├── home/page.tsx              # Main page: HomePage (session init) + HomePageContent (layout)
├── login/page.tsx             # Auth page
├── layout.tsx                 # Root layout: UserProfileProvider > AppProvider > EventBusProvider
├── api/
│   ├── start-sandbox-session/ # POST → HeyGen session token
│   └── extract-profile/       # POST → OpenAI profile extraction

lib/
├── orchestrator/              # AI orchestration layer
│   ├── intents.ts             # classifyIntent(message) → UserIntent (pure function, regex-based)
│   ├── journey-machine.ts     # journeyReducer(state, action) → { nextState, effects[] } (pure)
│   ├── useJourney.ts          # React hook: wires state machine to EventBus + avatar + UE5
│   ├── types.ts               # JourneyState, JourneyAction, JourneyEffect
│   └── index.ts               # Public exports
├── ue5/
│   └── bridge.ts              # useUE5Bridge(): typed UE5 commands, fade transitions, unit state
├── events.ts                  # EventBus class + useEventBus/useEventListener/useEmit hooks
├── useUE5WebSocket.ts         # Low-level WebSocket transport (ws://localhost:7788)
├── liveavatar/                # HeyGen SDK integration
│   ├── context.tsx            # LiveAvatarContextProvider (session, messages, voice state)
│   ├── useUserProfile.ts      # Dual-mode extraction (regex + AI) → AvatarDerivedProfile
│   ├── useAvatarActions.ts    # interrupt(), repeat(text), startListening(), stopListening()
│   ├── useSession.ts          # Session lifecycle (start, attach, stop)
│   ├── types.ts               # Message types, sender enum
│   └── index.ts
├── context.tsx                # UserProfileContext (firstName, dates, interests, journeyStage)
├── store.tsx                  # AppContext (auth, selectedHotel, bookings)
├── hotel-data.ts              # Mock data: hotels, rooms, amenities (only EDITION Lake Como active)
└── utils.ts                   # cn() utility

components/
├── panels/
│   ├── DestinationsOverlay.tsx  # Hotel selection grid
│   ├── RoomsPanel.tsx           # Room cards modal
│   ├── AmenitiesPanel.tsx       # Amenity cards modal
│   └── UnitDetailPanel.tsx      # Selected unit glassmorphic panel
├── liveavatar/
│   └── SandboxLiveAvatar.tsx    # Avatar renderer: SandboxSessionPlayer (chroma-key canvas) + DebugHud
├── ProfileSync.tsx              # Syncs AI-extracted profile → UserProfileContext
├── SunToggle.tsx                # Daylight/sunset/night toggle (sends to UE5)
├── HotelRoomCard.tsx
├── HotelAmenityCard.tsx
├── glass-panel.tsx              # Glassmorphism container
└── ui/                          # shadcn/ui library (50+ components)
```

## Critical Architectural Decisions

### 1. LiveAvatarContextProvider is at page level
`HomePage` fetches the HeyGen session token, then wraps `HomePageContent` in `LiveAvatarContextProvider`. This allows `useJourney()`, `ProfileSync`, and `DebugHud` to all share the same avatar context. The `SandboxSessionPlayer` is exported directly (not wrapped in its own provider).

### 2. Journey orchestration is a pure state machine
`journeyReducer()` in `lib/orchestrator/journey-machine.ts` is a **pure function** — no React, no side effects. It takes `(state, action)` and returns `{ nextState, effects[] }`. Effects are descriptive objects (`SPEAK`, `UE5_COMMAND`, `OPEN_PANEL`, etc.) executed by the `useJourney` hook. This makes the orchestration testable and traceable.

### 3. EventBus replaces pending* state
UI panels communicate with the orchestrator through a typed pub/sub EventBus (`lib/events.ts`), not through global mutable state. Events: `ROOM_CARD_TAPPED`, `AMENITY_CARD_TAPPED`, `UNIT_SELECTED_UE5`, `HOTEL_SELECTED`, `NAVIGATE_BACK`, etc.

### 4. Intent classification is centralized
All regex-based user intent detection lives in `lib/orchestrator/intents.ts`. The `classifyIntent(message)` function returns a typed `UserIntent` (`ROOMS`, `AMENITIES`, `LOCATION`, `INTERIOR`, `EXTERIOR`, `BACK`, `HOTEL_EXPLORE`, `UNKNOWN`). Designed to be swappable for AI-based NLU.

### 5. UE5 Bridge encapsulates WebSocket
`lib/ue5/bridge.ts` wraps the raw WebSocket hook with typed commands (`navigateToRooms()`, `selectRoom(id)`, `viewUnit("interior")`, etc.) and owns the fade transition animation state.

## UE5 WebSocket Protocol

**Outgoing (Frontend → UE5):**
- `{ type: "startTEST", value: "startTEST" }` — start the experience
- `{ type: "gameEstate", value: "rooms" | "amenities" | "location" | "default" }` — scene navigation
- `{ type: "selectedRoom", value: roomId }` — highlight room units
- `{ type: "unitView", value: "interior" | "exterior" }` — view selected unit
- `{ type: "communal", value: amenityId }` — navigate to amenity space
- `{ type: "sunPosition", value: "daylight" | "sunset" | "night" }` — change lighting

**Incoming (UE5 → Frontend):**
- `{ type: "unit", roomName: string, description?: string, price?: string, level?: string }` — user selected a unit in UE5

## Environment Variables

```env
# HeyGen (required)
HEYGEN_API_KEY=
HEYGEN_AVATAR_ID=
HEYGEN_VOICE_ID=
HEYGEN_CONTEXT_ID=

# OpenAI (optional — regex fallback if missing)
OPENAI_API_KEY=

# UE5 stream URL
NEXT_PUBLIC_VAGON_STREAM_URL=http://127.0.0.1
```

## Context Providers (nesting order in layout + page)

```
<UserProfileProvider>           ← lib/context.tsx (profile, journeyStage)
  <AppProvider>                 ← lib/store.tsx (auth, selectedHotel, bookings)
    <EventBusProvider>          ← lib/events.ts (pub/sub)
      <LiveAvatarContextProvider>  ← lib/liveavatar/context.tsx (avatar session, messages)
        <HomePageContent />        ← app/home/page.tsx
      </LiveAvatarContextProvider>
    </EventBusProvider>
  </AppProvider>
</UserProfileProvider>
```

Note: `LiveAvatarContextProvider` is rendered conditionally in `app/home/page.tsx` only after the session token is fetched. The other three providers wrap the entire app in `app/layout.tsx`.

## Commands

- `npm run dev` — start dev server
- `npx next build` — production build
- `npx tsc --noEmit` — type check (ignore `.next/dev/types` errors from deleted pages)

## Current State & Next Steps

- **Working**: Full journey flow from login → profile collection → destination selection → hotel exploration → room/amenity navigation via voice + UI
- **In Progress**: `ROOM_BOOKING` stage (final booking confirmation)
- **Only active hotel**: EDITION Lake Como (others are disabled in `hotel-data.ts`)
- **Mock auth**: Login uses a simulated delay, no real backend
