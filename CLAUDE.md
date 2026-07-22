# Omnam Metaverse Frontend — Project Context

> **Architecture note (2026-06).** The journey-state-machine brain (`/api/orchestrate`
> + `lib/orchestrator/*` + HeyGen FULL voice chat) was **retired**. The single brain
> is now an **OpenAI Realtime** speech-to-speech session that drives the experience
> **organically** via function calling — no scripted stages. HeyGen LiveAvatar runs
> in **LITE** mode (we bring our own audio). Historical context lives in git history.

---

## What This Is

A **Next.js 16** web app for booking luxury hotel experiences through an AI concierge
avatar ("Ava") with a real-time 3D digital twin rendered by **Unreal Engine 5** pixel
streaming (Vagon.io in the cloud; `ws://localhost:7788` locally).

The guest **talks** to Ava. A single OpenAI Realtime session listens, speaks, and
**calls functions** that navigate the UE5 scene (travel to the hotel, walk to rooms /
amenities / the surroundings, highlight a room plan, change lighting, open booking).
The flow is **not** a hard-coded state machine — Ava decides what to do from her
persona, the property dossier, and the live scene context. The guiding principle:
*give the AI all the context it needs and let it drive; don't script the experience.*

## Tech Stack

- **Framework**: Next.js 16 (App Router) + React 19 + TypeScript
- **Styling**: Tailwind CSS v4, glassmorphism design system
- **Brain**: **OpenAI Realtime** (`gpt-realtime-2`), browser-owned WebSocket, PCM16@24k
  in/out, server-VAD turn-taking, function calling → UE5. Token minted server-side
  (`/api/realtime-token`); only an ephemeral key reaches the browser.
- **Avatar**: **HeyGen LiveAvatar LITE** (`@heygen/liveavatar-web-sdk`) — video + lip-sync
  only; we push Realtime PCM via `repeatAudio()`. Rendered green-screen chroma-keyed
  onto a canvas (`components/realtime/ChromaAvatar.tsx`).
- **3D Backend**: UE5 pixel stream via iframe + Vagon SDK (cloud) or WebSocket (local).
- **Helper LLM routes**: POI discovery, post-session guest analysis (see below).
- **UI Components**: shadcn/ui subset in `components/ui/`.

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│  HomePage (app/home/page.tsx)                                │
│  Firebase auth → UE5 iframe (bg) → LoginOverlay → intro      │
│  └─ HomePageContentRealtime  (mounts after auth + intro)     │
└───────────────────────────────┬────────────────────────────-┘
                                 │
                  ┌──────────────▼───────────────┐
                  │  RealtimeSession              │   lib/realtime/session.ts
                  │  (one persistent brain)       │
                  └───┬───────────────────────┬───┘
        mic (PCM16@24k)│                       │ tool calls
   AudioWorklet ───────▶  OpenAI Realtime WS    ├──────────────┐
                        │  (browser-owned)      │              │
   HeyGen LITE ◀────────┤  output_audio.delta   │              ▼
   repeatAudio(base64)  └───────────────────────┘   ┌──────────────────────┐
        │                                            │  tool dispatcher     │ dispatcher.ts
        ▼                                            │  → useUE5Bridge      │
   avatar lip-syncs                                  └──────────┬───────────┘
                                                                ▼
                                                     UE5 (Vagon / ws://localhost:7788)
```

### Turn loop / data flow

1. **Mic → OpenAI.** `getUserMedia` → an `AudioWorklet` emits PCM16@24k frames →
   `input_audio_buffer.append` over the browser WS. Server VAD detects end-of-speech.
2. **OpenAI → HeyGen.** `response.output_audio.delta` (base64 PCM16@24k) is decoded and
   pushed to the avatar via `repeatAudio()` — same format both sides, no resampling.
   The avatar lip-syncs. (Latency is instrumented: t0 speech_stopped → t1 first delta
   → t2 first repeatAudio → t3 avatar speak_started.)
3. **Function calls → UE5.** When Ava calls a tool, `lib/realtime/dispatcher.ts`
   executes it against `useUE5Bridge` and returns a short string that becomes the
   `function_call_output`, so Ava can narrate the result naturally.
4. **Context injection.** Scene/profile deltas are injected as tiny conversation items
   (`session.injectContext`) so Ava always knows where the guest is — see Context Layers.
5. **Rooms panel.** Ava's `propose_room_plan` writes `currentRoomPlan` (`source:'planner'`)
   and the guest's card edits write it (`source:'user'`); both drive UE5 `selectedRoom`.

### Context Layers

- **L1 (per session, baked once)** — persona + a **distilled property dossier** (the
  active hotel's rooms/amenities, names, prices, capacities) + today's date and a
  year-inference rule. Built by `buildL1Instruction()` and baked into the ephemeral
  token in `/api/realtime-token`. This is the only "large" payload, paid **once** per
  session (the old per-turn mega-prompt is gone).
- **L3 (per scene change, tiny)** — a one-line `[context] The guest is now viewing: …`
  injected as a conversation item (~15 tokens). See `formatSceneDelta`.

## Critical Architectural Decisions

### 1. One organic brain — no journey state machine
There is no `journeyReducer`, no stage enum driving behaviour, no regex intent
classifier. The OpenAI Realtime session decides everything from its persona, the L1
dossier, the tool schemas, and injected scene context. Behaviour is shaped by
*context and tools*, not by hard-coded scripts.

### 2. RealtimeSession owns the OpenAI WS + HeyGen LITE in the browser
`lib/realtime/session.ts` runs the OpenAI Realtime session as a **browser-owned**
WebSocket (the "manual" path) so we can tune turn-taking for low latency and handle
tool calls directly. It also owns: HeyGen keep-alive (idle-timeout + CORS-blocked
REST → server proxies), reconnect on `SESSION_DISCONNECTED`, a one-shot proactive
greeting, and queued `injectContext` (flushed on WS open).

### 3. Abort-safe lifecycle (no double avatar)
`start()` is async and auto-runs from a mount effect. React StrictMode (and HMR)
fire mount→cleanup→mount, so `start()` re-checks `superseded()` (`stopping || !running`)
after **every** `await` and releases anything it created via `teardown()` instead of
zombifying. Avatar startup and mic/Realtime startup are **separate** try-blocks: a
mic/permission failure leaves the avatar up (never a black thumbnail).

### 4. HeyGen LITE = bring-your-own-audio
`new LiveAvatarSession(token, { voiceChat: false })`; OpenAI PCM deltas are pushed via
`repeatAudio(base64)`. An **anti-echo gate** drops mic frames while the avatar speaks
(+1s tail) so Ava's own voice can't re-trigger VAD.

### 5. Tools → UE5 via the dispatcher, with timing gates
`dispatcher.ts` maps each tool to a `useUE5Bridge` command. Gates that keep UE5 in sync:
- **UE5-ready gate** — `travel_to_hotel` holds the `startTEST` until UE5 has sent its
  first message (`bridge.isReady`; works for Vagon + local), then departs and tells Ava
  she's arrived. Ava never "arrives" in a scene that hasn't loaded.
- **Settle gate** — scene-dependent sends (room highlight, POI markers) wait for the
  post-travel (~3.5s) / post-nav (~1.2s) scene load.
- **Capacity guardrail** — `propose_room_plan` is rejected if total capacity < party size.
- Hotel navigation is gated behind `arrived` (must `travel_to_hotel` first).

### 6. Auto-start, no "Begin" button
The avatar starts on mount (after auth + intro). The lighting toggle renders only after
the guest has travelled to the hotel (hidden in the lounge).

### 7. OmnamStore is the app state; compat shims remain
`lib/omnam-store.tsx` holds `profile + app + currentRoomPlan` (decoupled from the deleted
journey machine). `lib/context.tsx` (`useUserProfileContext`) and `lib/store.tsx`
(`useApp`) are thin shims reading from it.

## Function-Calling Tools (lib/realtime/tools.ts)

Schemas are built from the live catalog (enums are real room ids / amenity names):
`travel_to_hotel`, `return_to_lounge`, `save_profile`, `navigate_to` (rooms | amenities
| location | default), `set_lighting`, `view_unit` (interior | exterior),
`show_points_of_interest`, `open_booking`, `go_to_amenity`, `select_room`,
`propose_room_plan`.

## UE5 WebSocket Protocol

**Outgoing (Frontend → UE5):**
- `{ type: "startTEST", value: "startTEST" }` — travel from lounge to the hotel
- `{ type: "virtualLounge", value: "virtualLounge" }` — return to the lounge
- `{ type: "gameEstate", value: "rooms" | "amenities" | "location" | "default" }` — scene nav
- `{ type: "selectedRoom", value: "r1,r2,..." }` — comma-separated room-type ids to highlight
  (derived from `currentRoomPlan`; quantities not sent — UE5 only needs the set of types)
- `{ type: "unitView", value: "interior" | "exterior" }` — enter/exit the selected unit
- `{ type: "communal", value: amenityId }` — walk to an amenity space
- `{ type: "sunPosition", value: "daylight" | "sunset" | "night" }` — lighting
- `{ type: "osm_data", value: "<json string>" }` — POI markers for the location scene
- `{ type: "inputRelease" }` — force-release held mouse input (iframe pointer fix)

**Incoming (UE5 → Frontend):**
- `{ type: "unit", roomName, description?, price?, level? }` — guest clicked a unit in 3D
- Any first message also flips `bridge.isReady = true` (the UE5-ready signal).

## Environment Variables

`.env.local` (cleaned to live keys only):

```env
# Firebase (auth + persistence)
NEXT_PUBLIC_FIREBASE_API_KEY=          NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_DATABASE_URL=     NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# UE5 pixel stream — "local" (localhost) or "vagon" (cloud)
NEXT_PUBLIC_STREAM_MODE=local
NEXT_PUBLIC_VAGON_STREAM_URL=http://127.0.0.1

# HeyGen LiveAvatar LITE (creds read server-side; NEXT_PUBLIC_ prefix tolerated)
NEXT_PUBLIC_HEYGEN_API_KEY=    NEXT_PUBLIC_HEYGEN_API_URL=    NEXT_PUBLIC_HEYGEN_AVATAR_ID=

# OpenAI — Realtime brain (server key) + helper routes
OPENAI_API_KEY=                NEXT_PUBLIC_OPENAI_API_KEY=

# Google Places (server-side) + Vercel Blob (latency logs)
GOOGLE_PLACES_API_KEY=         BLOB_READ_WRITE_TOKEN=

# Optional OpenAI Realtime overrides (sane defaults in code):
# OPENAI_REALTIME_MODEL=gpt-realtime-2   OPENAI_REALTIME_VOICE=marin
# OPENAI_VAD_TYPE=server_vad   OPENAI_VAD_SILENCE_MS=250   OPENAI_VAD_EAGERNESS=high
```

## Context Providers (nesting order)

```
<AuthProvider>                     ← lib/auth-context (Firebase user identity)
  <OmnamStoreProvider>             ← lib/omnam-store (profile + app + currentRoomPlan)
    <GuestIntelligenceProvider>    ← lib/guest-intelligence (behavioural tracking)
      {children}                   ← app/home/page.tsx (renders HomePageContentRealtime
    </GuestIntelligenceProvider>        after auth + intro complete)
  </OmnamStoreProvider>
</AuthProvider>
```

All three wrap the app in `app/layout.tsx`. The Vagon SDK is loaded via a `<Script>`
tag in the root layout. `lib/context.tsx` / `lib/store.tsx` are compat shims over the store.

## Commands

- `npm run dev` — start dev server
- `npx next build` — production build (clear `.next` first if stale route types complain)
- `npx tsc --noEmit` — type check

## Current State & Next Steps

- **Working**: login → auto-started Ava → organic voice journey (travel, rooms,
  amenities, location/POI, lighting, room-plan proposals, booking) via OpenAI Realtime
  function calling → UE5; RoomsPanel card edits; Firebase persistence; returning-guest
  hydration (inline in `HomePageContentRealtime`).
- **Only active hotel**: EDITION Lake Como (`lib/hotels/lake-como.ts`).
- **Auth**: Firebase.
- **Branch**: this architecture lives on `dev` (the active branch). `main` still
  carries the pre-refactor brain until `dev` is merged down.
