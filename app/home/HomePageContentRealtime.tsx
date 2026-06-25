"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RealtimeSession } from "@/lib/realtime/session"
import { createToolDispatcher } from "@/lib/realtime/dispatcher"
import { PILOT_HOTEL_SLUG } from "@/lib/realtime/context"
import { useUE5Bridge } from "@/lib/ue5/bridge"
import { useOmnamStore } from "@/lib/omnam-store"
import { normalizeInventory, selectedUnitIds } from "@/lib/selection"
import { RoomsPanel } from "@/components/panels/RoomsPanel"
import { ChromaAvatar } from "@/components/realtime/ChromaAvatar"
import { ChatPanel, type ChatMessage } from "@/components/realtime/ChatPanel"
import { MessageSender } from "@/lib/liveavatar/types"
import { getHotelBySlug, getRoomsByHotelId, type RoomPlan, type RoomPlanEntry } from "@/lib/hotel-data"
import { useAuth } from "@/lib/auth-context"
import { useIncrementalPersistence } from "@/lib/firebase/useIncrementalPersistence"
import { SunToggle } from "@/components/SunToggle"
import { Mic, MicOff, MessageSquare } from "lucide-react"

// D.1b — the realtime brain mounted inside /home's shell (auth + login overlay +
// UE5 iframe live in HomePage). Reuses the real OmnamStore + auth, so returning
// guests are recognised and greeted. Flag-gated; old brain stays the default.
// (Firebase write-persistence of the realtime transcript is D.1c.)

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return ""
  }
}

// The first unit highlight after (re)entering the rooms scene waits this long so
// UE5 has time to spawn the room actors — sending selectUnits into a still-loading
// scene gets dropped (it has nothing to color yet). Later edits emit immediately.
const ROOMS_SETTLE_MS = 1200

// Scene labels that still count as "the rooms experience" for highlight emits —
// includes viewing a unit's interior/exterior, so panel edits keep flowing instead
// of being frozen the instant the guest (or Ava) steps inside a unit.
const ROOMS_CONTEXT = new Set(["rooms", "inside the unit", "unit exterior"])

// In vagon mode the UE5 stream launches slowly (AWS/Vagon spin-up), so we hold
// the avatar boot until UE5 signals it's connected (`ue5Init`). Local UE5 is fast
// — start immediately, as before.
const STREAM_MODE = process.env.NEXT_PUBLIC_STREAM_MODE || "local"

// Lingering-in-the-lounge nudges. The LLM has no sense of wall-clock time, so the
// "don't get stuck in the gallery" reminder is a deterministic client timer that
// injects a context note (respond:true) telling Ava to gently offer to move on.
// Armed only while in the lounge; reset on each guest turn (so it fires during a
// genuine lull, never over an active conversation); cancelled the moment the guest
// travels to the hotel. Tunable.
const LOUNGE_NUDGE_MS = 75_000        // gentle check-in after a quiet stretch
const LOUNGE_NUDGE_FIRM_MS = 160_000  // a warmer "shall we head over?" if still here

export default function HomePageContentRealtime({ onEnded, ue5Ready = false }: { onEnded?: () => void; ue5Ready?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Latest onEnded in a ref so the session's onFarewellSpoken callback (wired once
  // at start) always calls the current prop, not the closure captured on mount.
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded
  const sessionRef = useRef<RealtimeSession | null>(null)
  const { state, dispatch } = useOmnamStore()
  const { userProfile, returningUserData } = useAuth()
  const currentRoomPlan = state.currentRoomPlan

  // Live mirror so the tool dispatcher (created once at start) reads the CURRENT
  // profile (e.g. party size) rather than the empty profile captured at start.
  const stateRef = useRef(state)
  stateRef.current = state

  const [active, setActive] = useState(false)
  const [atHotel, setAtHotel] = useState(false)
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)
  const [scene, setScene] = useState("lounge")
  // Input mode + mic. `mode` swaps the avatar thumbnail for a text chat surface;
  // `micMuted` is the guest's manual mic toggle (voice mode). The transcript is
  // shared by both modes so the conversation is continuous across toggles.
  const [mode, setMode] = useState<"voice" | "chat">("voice")
  const [micMuted, setMicMuted] = useState(false)
  const [transcript, setTranscript] = useState<ChatMessage[]>([])

  // Interior-entry consent gate. `userTurnSeqRef` counts genuine guest turns;
  // `focusTurnRef` records the count at the moment a unit was last focused. Bare
  // view_unit interior is allowed only once the guest has spoken SINCE the focus
  // (userTurnSeq > focusTurn) — so presenting a unit and stepping inside can't
  // happen in the same beat. See the dispatcher's view_unit gate.
  const userTurnSeqRef = useRef(0)
  const focusTurnRef = useRef(0)

  // Single source of truth for the conversation: voice turns + Ava turns arrive
  // via the session's onTranscript callback; typed turns are appended directly
  // by onSendChat. The same buffer renders in ChatPanel AND feeds Firebase.
  const appendTranscript = useCallback((who: "user" | "ava", text: string) => {
    const t = text.trim()
    if (!t) return
    if (who === "user") userTurnSeqRef.current += 1 // a real guest turn (gates interior entry)
    setTranscript((prev) => [...prev, { who, text: t, timestamp: Date.now() }])
  }, [])

  // Persist the session (profile + guest intelligence + transcript) to Firebase
  // so returning guests accumulate data and the admin portal can replay the
  // conversation. The DI hooks map the live transcript into the snapshot shape;
  // useProfile contributes user turns only (analyze-guest reads these).
  const { writeEndOfSessionSnapshot } = useIncrementalPersistence({
    useContext: () => ({
      messages: transcript.map((m) => ({
        sender: m.who === "user" ? MessageSender.USER : MessageSender.AVATAR,
        message: m.text,
        timestamp: m.timestamp,
      })),
    }),
    useProfile: () => ({
      userMessages: transcript
        .filter((m) => m.who === "user")
        .map((m) => ({ message: m.text, timestamp: m.timestamp })),
    }),
  })

  const { rooms, hotelName } = useMemo(() => {
    const hotel = getHotelBySlug(PILOT_HOTEL_SLUG)
    return { rooms: hotel ? getRoomsByHotelId(hotel.id) : [], hotelName: hotel?.name ?? "the hotel" }
  }, [])

  const recommendedPlan = useMemo<RoomPlan | null>(() => {
    if (!currentRoomPlan || currentRoomPlan.rooms.length === 0) return null
    const byId = new Map(rooms.map((r) => [r.id, r]))
    const entries: RoomPlanEntry[] = []
    for (const entry of currentRoomPlan.rooms) {
      const room = byId.get(entry.roomId)
      if (!room) continue
      entries.push({ roomId: room.id, roomName: room.name, quantity: entry.quantity, pricePerNight: room.price, occupancy: parseInt(room.occupancy, 10) || 0 })
    }
    if (entries.length === 0) return null
    // Prefer the store's reconciled totals — they reflect per-unit pricing once
    // UE5 inventory has arrived (and equal the catalog sums before that). Fall
    // back to catalog-derived sums if the store hasn't computed them yet.
    return {
      entries,
      totalCapacity: currentRoomPlan.capacity || entries.reduce((s, e) => s + e.occupancy * e.quantity, 0),
      totalPricePerNight: currentRoomPlan.totalPerNight || entries.reduce((s, e) => s + e.pricePerNight * e.quantity, 0),
    }
  }, [currentRoomPlan, rooms])

  // Returning-guest hydration injected at session start (queued until WS opens).
  const hydration = useMemo(() => {
    const name = userProfile?.firstName?.trim()
    const prefs = returningUserData?.preferences
    if (!name && !prefs) return ""
    const parts: string[] = []
    if (name) parts.push(`Name: ${name}.`)
    if (userProfile?.nationality) parts.push(`Nationality: ${userProfile.nationality}.`)
    if (prefs) parts.push(`Soft hints from past visits (confirm, don't assume): ${safeJson(prefs)}.`)
    return `[returning guest — background only] ${parts.join(" ")} When you greet them (once), use their name. Still ask for THIS trip's dates, party, and room needs before travelling — never assume them.`
  }, [userProfile, returningUserData])

  // UE5 tap → drive the reducer (focus + select-if-new) AND tell Ava. A REAL tap
  // carries a numeric `id` (new UE5 contract). Messages WITHOUT an id are legacy
  // selection echoes UE5 emits when we set selection/focus programmatically — they
  // are NOT user taps, so ignore them (otherwise a programmatic selectUnits makes
  // Ava narrate a phantom "tap"). Once UE5 sends real taps they'll include `id`.
  // True once the guest has EXPLICITLY picked a unit this plan — a real tap, or
  // Ava naming one (view_unit unitId / select_units). The plan's auto-focus does
  // NOT count, so view_unit can't whisk the guest into a room they never chose.
  // Reset when a new plan is proposed.
  const explicitPickRef = useRef(false)

  const onUnitSelected = useCallback((payload: { id?: number; roomName: string }) => {
    if (typeof payload.id !== "number") {
      // Legacy selection echo (no id) — not a real tap, ignore.
      return
    }
    explicitPickRef.current = true // a real tap is an explicit pick
    focusTurnRef.current = userTurnSeqRef.current // tapping focuses; entering is a separate, later turn
    dispatch({ type: "TAP_UNIT", unitId: payload.id })
    sessionRef.current?.injectContext(
      `[context] The guest tapped ${payload.roomName} in the scene.`, { respond: true })
  }, [dispatch])

  // Inventory is PRELOADED proactively on travel + levelLoaded (see below) so it's
  // ready before the guest asks for rooms — but it no longer auto-triggers a room
  // recommendation. Rooms are on-demand (the guest asks, or asked up front); on
  // arrival Ava just welcomes + offers options (driven by the persona + the
  // travel_to_hotel tool result).

  // Chunk accumulator — UE5 may split a large catalog across several messages so
  // the channel's per-message size limit doesn't drop it. Keyed by chunk index;
  // finalized once all `total` chunks are in.
  const invAccumRef = useRef<{ total: number; parts: Map<number, unknown[]> }>({ total: 0, parts: new Map() })
  // Whether Ava has already been briefed with the inventory for THIS arrival.
  // The store is always refreshed on every finalize, but Ava is told only once
  // per arrival (reset in onArrived) — repeated full-inventory dumps from the
  // preload/levelLoaded/poll triggers were bloating her context and confusing her.
  const injectedInventoryRef = useRef(false)

  // Finalize a COMPLETE inventory → always refresh the store. Brief Ava with a
  // compact table ONCE per arrival (respond:false — background only; it does NOT
  // prompt a room recommendation). Rooms stay on-demand.
  const finalizeInventory = useCallback((rawUnits: unknown[]) => {
    const units = normalizeInventory(rawUnits)
    dispatch({ type: "SET_UNIT_INVENTORY", units })
    if (units.length === 0) {
      return
    }
    if (injectedInventoryRef.current) {
      return
    }
    injectedInventoryRef.current = true
    const lines = units.map((u) =>
      `#${u.id} ${u.roomTypeId} L${u.level}${u.view ? " " + u.view : ""} $${u.price} ${u.available ? "avail" : "booked"}`)
    sessionRef.current?.injectContext(
      `[unit inventory — background] ${units.length} units are loaded and ready for when the guest wants rooms:\n${lines.join("\n")}`, { respond: false })
  }, [dispatch])

  // UE5 inventory push. Single message (total<=1) finalizes immediately; chunked
  // messages accumulate by index and finalize when all `total` chunks arrive.
  const onUnitInventory = useCallback((msg: { units: unknown[]; chunk?: number; total?: number }) => {
    const units = Array.isArray(msg.units) ? msg.units : []
    const total = typeof msg.total === "number" ? msg.total : 1
    const chunk = typeof msg.chunk === "number" ? msg.chunk : 0
    if (total <= 1) { finalizeInventory(units); return }
    const acc = invAccumRef.current
    // (Re)start a fresh set on chunk 0 or when the total changes (a new export run).
    if (acc.total !== total || chunk === 0) { acc.total = total; acc.parts = new Map() }
    acc.parts.set(chunk, units)
    if (acc.parts.size >= total) {
      const all: unknown[] = []
      for (let i = 0; i < total; i++) { const p = acc.parts.get(i); if (p) all.push(...p) }
      invAccumRef.current = { total: 0, parts: new Map() }
      finalizeInventory(all)
    }
  }, [finalizeInventory])

  const ue5 = useUE5Bridge({ onUnitSelected, onUnitInventory })

  // Live mirror of UE5 readiness so the dispatcher (created once at start) can
  // poll the CURRENT value rather than the false captured at session start.
  const ue5ReadyRef = useRef(false)
  useEffect(() => {
    // Either the page-level readiness signal (the always-mounted listener that
    // caught UE5's first message before this component mounted) OR the bridge's
    // own first-message flag. In vagon the prop is already true at mount (the
    // brain only mounts once UE5 is live), so travel_to_hotel isn't blocked.
    ue5ReadyRef.current = ue5Ready || ue5.isReady
  }, [ue5Ready, ue5.isReady])

  // PRELOAD on levelLoaded — the RELIABLE trigger: the hotel level finished
  // loading so units exist. (Arrival/startTEST also kicks a pull, but fires while
  // the map is still loading.) Decoupled from recommending — just fills the store.
  const ue5RequestInventory = ue5.requestInventory
  const ue5LevelLoadedSeq = ue5.levelLoadedSeq
  useEffect(() => {
    if (ue5LevelLoadedSeq <= 0) return
    ue5RequestInventory()
  }, [ue5LevelLoadedSeq, ue5RequestInventory])

  // Lightweight fallback poll after arrival, in case `levelLoaded` isn't emitted
  // or the first pull raced the map load. A few attempts only — `levelLoaded` is
  // the primary trigger. Stops the moment `unitInventory` is populated.
  const inventoryCount = state.unitInventory.length
  useEffect(() => {
    if (!atHotel) return
    if (inventoryCount > 0) {
      // Inventory already present — no need to poll.
      return
    }
    let attempts = 0
    const MAX = 3
    const ask = () => {
      attempts += 1
      ue5RequestInventory()
    }
    ask() // immediate on arrival
    const id = window.setInterval(() => {
      if (attempts >= MAX) {
        window.clearInterval(id)
        return
      }
      ask()
    }, 1500)
    return () => window.clearInterval(id)
  }, [atHotel, inventoryCount, ue5RequestInventory, ue5.isConnected])

  // Mark when we (re)enter the rooms scene, so the FIRST highlight after entry
  // waits out the scene-build settle (see emit effect). Only "rooms" resets it —
  // stepping into a unit's interior/exterior stays within the same settled scene.
  const roomsEnteredAtRef = useRef(0)
  useEffect(() => {
    if (scene === "rooms") roomsEnteredAtRef.current = Date.now()
  }, [scene])
  // selKey of the last highlight we actually sent — so a scene change that ISN'T a
  // selection change (e.g. stepping into a unit) doesn't re-send selectUnits.
  const lastEmitKeyRef = useRef<string | null>(null)

  // Single authoritative emit: send the reconciled unit selection to UE5. Stays
  // active across the whole rooms experience (incl. interior/exterior views) so
  // panel edits keep flowing; only suppressed when the guest is genuinely elsewhere
  // (lounge, amenities, location). The first highlight after entering rooms waits
  // out ROOMS_SETTLE_MS so it doesn't race UE5 spawning the room actors.
  const { unitSelection, unitInventory } = state
  const ue5SelectUnits = ue5.selectUnits
  const ue5SelectRoom = ue5.selectRoom
  const selKey = useMemo(
    () => `${selectedUnitIds(unitSelection).join(",")}|${unitSelection.activeUnitId ?? ""}`,
    [unitSelection])
  useEffect(() => {
    if (!ROOMS_CONTEXT.has(scene)) return // only (re)highlight within the rooms experience
    // Re-highlight when the SELECTION changed, or when (re)entering the rooms
    // OVERVIEW. Do NOT re-send for a switch to interior/exterior with an unchanged
    // selection: selectUnits carries `focus`, which UE5 re-applies as a camera
    // look-at and cancels the interior transition the guest just asked for.
    if (lastEmitKeyRef.current === selKey && scene !== "rooms") return
    const emit = () => {
      lastEmitKeyRef.current = selKey
      if (unitInventory.length > 0) {
        // Defensive: never send an unavailable unit to UE5, regardless of how it got
        // into a bucket (auto-fill + AI already filter; this guards taps/edge cases).
        const availableIds = new Set(unitInventory.filter((u) => u.available).map((u) => u.id))
        const ids = selectedUnitIds(unitSelection).filter((id) => availableIds.has(id))
        ue5SelectUnits(ids, unitSelection.activeUnitId)   // unit-level (new UE5)
      } else if (currentRoomPlan?.rooms.length) {
        // FALLBACK pre-inventory: keep the old type-level highlight so nothing breaks.
        ue5SelectRoom(Array.from(new Set(currentRoomPlan.rooms.map((r) => r.roomId))).join(","))
      }
    }
    const wait = roomsEnteredAtRef.current + ROOMS_SETTLE_MS - Date.now()
    if (wait <= 0) { emit(); return }
    const id = window.setTimeout(emit, wait)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, scene, unitInventory.length])

  // Keep Ava in sync with GUEST-driven plan edits on the panel cards (she made
  // planner edits herself, so only feed back source: 'user' changes).
  const lastPlanFeedbackRef = useRef<string | null>(null)
  useEffect(() => {
    const plan = currentRoomPlan
    if (!plan || plan.source !== "user") return
    const key = plan.rooms.map((r) => `${r.roomId}x${r.quantity}`).join(",")
    if (lastPlanFeedbackRef.current === key) return
    lastPlanFeedbackRef.current = key
    const summary =
      plan.rooms
        .map((r) => `${r.quantity}× ${rooms.find((x) => x.id === r.roomId)?.name ?? r.roomId}`)
        .join(", ") || "empty"
    sessionRef.current?.injectContext(
      `[plan updated by guest] The room plan is now: ${summary} ($${plan.totalPerNight}/night, sleeps ${plan.capacity}).`,
      { respond: false },
    )
  }, [currentRoomPlan, rooms])

  // Lingering-in-the-lounge nudges. Only while the guest is still in the lounge
  // (active && !atHotel). Re-armed on every guest turn (lastGuestTurnTs) so it
  // only fires during a genuine lull; both timers are cleared on travel (atHotel
  // flips) and on unmount. See LOUNGE_NUDGE_MS / _FIRM_MS.
  const lastGuestTurnTs = useMemo(() => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].who === "user") return transcript[i].timestamp
    }
    return 0
  }, [transcript])
  useEffect(() => {
    if (!active || atHotel) return
    const gentle = window.setTimeout(() => {
      sessionRef.current?.injectContext(
        "[context] The guest has been quiet in the virtual lounge for a little while. Gently check in and remind them, in one warm line, that you can take them over to the hotel (or to the rooms) whenever they're ready. Do not pressure them or repeat any gallery invitation.",
        { respond: true },
      )
    }, LOUNGE_NUDGE_MS)
    const firm = window.setTimeout(() => {
      sessionRef.current?.injectContext(
        "[context] The guest is still lingering in the virtual lounge. Warmly suggest heading over to the hotel now so they can see it for themselves — offer to take them. Keep it to one inviting line.",
        { respond: true },
      )
    }, LOUNGE_NUDGE_FIRM_MS)
    return () => {
      window.clearTimeout(gentle)
      window.clearTimeout(firm)
    }
  }, [active, atHotel, lastGuestTurnTs])

  const start = useCallback(async () => {
    if (!videoRef.current || sessionRef.current) return
    setActive(true)
    const session = new RealtimeSession(
      videoRef.current,
      {
        onTranscript: appendTranscript,
        onFarewellSpoken: () => onEndedRef.current?.(),
        // Surface the session's own diagnostics to the console. Lines are tagged
        // [OpenAI] / [HeyGen] at the source, so a failure (❌/⚠️) tells you which
        // side broke — instead of a healthy-looking avatar hiding a dead brain.
        onLog: (line) =>
          /^(❌|⚠️)/.test(line)
            ? console.error(`[realtime] ${line}`)
            : console.log(`[realtime] ${line}`),
        onStatus: (s) => console.log(`[realtime:status] ${s}`),
      },
      { greetOnReady: true },
    )
    session.setToolHandler(
      createToolDispatcher(ue5, {
        onScene: setScene,
        saveProfile: (updates) => dispatch({ type: "UPDATE_PROFILE", updates }),
        setRoomPlan: (plan) => {
          // A new recommendation resets the explicit-pick gate: the guest hasn't
          // chosen a specific unit of THIS plan yet (auto-focus doesn't count).
          explicitPickRef.current = false
          focusTurnRef.current = userTurnSeqRef.current // plan auto-focus is a fresh presentation
          dispatch({ type: "SET_ROOM_PLAN", plan })
        },
        onRoomsPanel: setShowRoomsPanel,
        onArrived: (arrived: boolean) => {
          setAtHotel(arrived)
          // Allow ONE fresh inventory briefing to Ava for this arrival. The actual
          // pull is driven by `levelLoaded` (reliable) + the fallback poll below —
          // we no longer fire a preload here (it raced the map load and just added
          // to the request/inject churn).
          if (arrived) injectedInventoryRef.current = false
        },
        getPartySize: () => {
          const gc = stateRef.current.profile.guestComposition
          const n = (gc?.adults ?? 0) + (gc?.children ?? 0)
          return n > 0 ? n : undefined
        },
        isUe5Ready: () => ue5ReadyRef.current,
        notify: (text) => sessionRef.current?.injectContext(text, { respond: true }),
        getInventory: () => stateRef.current.unitInventory,
        selectUnits: (unitIds) => {
          explicitPickRef.current = true // Ava naming specific units is an explicit pick
          focusTurnRef.current = userTurnSeqRef.current // ...but presenting it is not consent to enter
          dispatch({ type: "AI_SELECT_UNITS", unitIds })
        },
        setActiveUnit: (unitId) => {
          explicitPickRef.current = true // focusing a named unit is an explicit pick
          focusTurnRef.current = userTurnSeqRef.current // ...but presenting it is not consent to enter
          dispatch({ type: "SET_ACTIVE_UNIT", unitId })
        },
        hasExplicitPick: () => explicitPickRef.current,
        // Consent to ENTER: the guest must have spoken since the focus was set, so
        // a select_units→interior (or tap→interior) chain is blocked until they ask.
        hasUserSpokenSinceFocus: () => userTurnSeqRef.current > focusTurnRef.current,
        getPlan: () => stateRef.current.currentRoomPlan,
        // Guest confirmed they want to leave → close panels and start the close:
        // mute mic, let Ava speak her farewell, then onFarewellSpoken fires onEnded.
        onEndExperience: () => {
          setShowRoomsPanel(false)
          sessionRef.current?.beginClose()
        },
      }),
    )
    sessionRef.current = session
    // Queue hydration before the WS opens; flushed on open. respond:false — Ava
    // greets ONCE on the guest's first turn (proactive auto-greet caused a
    // double welcome), and the persona still drives the intake.
    if (hydration) session.injectContext(hydration, { respond: false })
    await session.start()
  }, [ue5, dispatch, hydration, userProfile, appendTranscript])

  // Mirror the (changing) end-of-session flush in a ref so the mount-only
  // lifecycle effect below calls the LATEST one (with the full transcript)
  // rather than the empty closure captured on first render.
  const endSessionRef = useRef(writeEndOfSessionSnapshot)
  endSessionRef.current = writeEndOfSessionSnapshot

  // Gate the avatar boot. In vagon the page already gates this component's MOUNT on
  // UE5 readiness (HomePage's always-mounted listener), so `ue5Ready` is true by the
  // time we mount — start immediately. The `ue5.initialized` fallback covers the case
  // where the bridge itself catches `ue5Init` first. Local always starts immediately.
  const canStart = STREAM_MODE !== "vagon" || ue5Ready || ue5.initialized

  // Session lifecycle (mount-only): beforeunload + teardown on unmount. Kept
  // separate from the gated start so the gate flipping doesn't tear down/restart
  // a live session. The cleanup stops the session, so React StrictMode's
  // mount→unmount→mount only yields one live session.
  useEffect(() => {
    const onUnload = () => {
      void endSessionRef.current()
      void sessionRef.current?.stop()
    }
    window.addEventListener("beforeunload", onUnload)
    return () => {
      window.removeEventListener("beforeunload", onUnload)
      void endSessionRef.current()
      void sessionRef.current?.stop()
      sessionRef.current = null
    }
  }, [])

  // Auto-start once the gate is open — no "Begin" gate. The avatar and the
  // mic/Realtime start INDEPENDENTLY (see RealtimeSession.start), so a
  // getUserMedia/permission hiccup never tears the avatar down to black.
  // start() is idempotent (guards on sessionRef), so a re-run is a no-op.
  useEffect(() => {
    if (canStart) void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStart])

  const onAddRoom = useCallback((roomId: string) => dispatch({ type: "EDIT_ROOM_PLAN", edit: { kind: "add", roomId } }), [dispatch])
  const onSetRoomQuantity = useCallback((roomId: string, quantity: number) => dispatch({ type: "EDIT_ROOM_PLAN", edit: { kind: "setQuantity", roomId, quantity } }), [dispatch])
  const onRemoveRoom = useCallback((roomId: string) => dispatch({ type: "EDIT_ROOM_PLAN", edit: { kind: "remove", roomId } }), [dispatch])

  // Effective mic mute = the guest's manual toggle OR chat mode (text-only input).
  // Re-applied to the session whenever either changes (or once it's live). Leaving
  // chat restores the manual state, so a mic-mute survives a chat round-trip.
  useEffect(() => {
    sessionRef.current?.setMicMuted(mode === "chat" || micMuted)
  }, [mode, micMuted, active])

  // Chat is text-only: silence Ava's audio while in chat mode (the transcript
  // still fills from the response text). Voice mode plays her aloud.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = mode === "chat"
  }, [mode, active])

  const toggleMic = useCallback(() => setMicMuted((m) => !m), [])
  const toggleMode = useCallback(() => setMode((m) => (m === "chat" ? "voice" : "chat")), [])
  const onSendChat = useCallback((text: string) => {
    const t = text.trim()
    if (!t || !sessionRef.current) return
    // Typed turns never echo back through onTranscript (text input isn't
    // audio-transcribed), so append directly — no double-counting.
    appendTranscript("user", t)
    sessionRef.current.injectContext(t, { respond: true })
  }, [appendTranscript])

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" onDragStart={(e) => e.preventDefault()}>
      {/* Rooms panel — right side */}
      {showRoomsPanel && (
        <div className="pointer-events-auto fixed right-4 top-4 bottom-[calc(4rem+2vh)] z-20" style={{ width: 375 }}>
          <RoomsPanel
            visible={showRoomsPanel}
            hotelName={hotelName}
            rooms={rooms}
            recommendedPlan={recommendedPlan}
            onClose={() => setShowRoomsPanel(false)}
            onAddRoom={onAddRoom}
            onSetRoomQuantity={onSetRoomQuantity}
            onRemoveRoom={onRemoveRoom}
          />
        </div>
      )}

      {/* Avatar control panel — bottom-left glass pill. The subtree stays mounted
          so the session can attach to the avatar video, but it's hidden (off-screen,
          not unmounted) until the session is `active` — which only happens after
          start() runs, i.e. after UE5/Vagon is connected (canStart). This keeps the
          empty black thumbnail from showing while the UE5 stream is still loading. */}
      <div className={`absolute inset-x-0 bottom-0 flex flex-col px-6 pb-10 ${active ? "" : "invisible pointer-events-none"}`}>
        <div className="mt-auto">
          <div className="pointer-events-auto inline-flex items-stretch rounded-[20px] border border-white/25 bg-gradient-to-br from-white/20 via-white/10 to-white/5 shadow-[0_20px_60px_-28px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
            {/* Avatar thumbnail (chroma-keyed onto black). ALWAYS mounted so the
                HeyGen session stays attached — in chat mode it's pinned off-screen
                rather than unmounted (unmounting would tear the session down and
                lose the conversation). */}
            <div
              className={mode === "chat" ? "pointer-events-none invisible absolute -left-[9999px] top-0" : "p-[5px] pr-0"}
              aria-hidden={mode === "chat"}
            >
              <div className="relative overflow-hidden rounded-[16px] bg-black shadow-2xl" style={{ width: 210, height: 262 }}>
                <ChromaAvatar videoRef={videoRef} fit="cover" style={{ width: "100%", height: "100%" }} />
              </div>
            </div>

            {/* Chat surface — takes the thumbnail's slot in chat mode. */}
            {mode === "chat" && (
              <div className="p-[5px] pr-0">
                <ChatPanel messages={transcript} onSend={onSendChat} width={450} height={393} />
              </div>
            )}

            {/* Right body — vertical button column */}
            <div className="flex min-w-[70px] flex-col items-center justify-end gap-3 px-[15px] py-4">
              {/* Lighting toggle is a hotel-scene control — hidden in the lounge
                  (at start and after returning from the experience). */}
              {atHotel && <SunToggle value={ue5.sunState} onChange={ue5.changeSunPosition} />}
              {/* Mic mute — voice mode only (chat is text-only). */}
              {active && mode === "voice" && (
                <button
                  onClick={toggleMic}
                  title={micMuted ? "Unmute microphone" : "Mute microphone"}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-lg backdrop-blur-md transition-colors hover:bg-white/20"
                >
                  {micMuted ? <MicOff className="h-5 w-5 text-red-400" /> : <Mic className="h-5 w-5 text-white" />}
                </button>
              )}
              {/* Voice ↔ chat toggle. */}
              {active && (
                <button
                  onClick={toggleMode}
                  title={mode === "chat" ? "Switch to voice" : "Switch to chat"}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-lg backdrop-blur-md transition-colors hover:bg-white/20"
                >
                  {mode === "chat" ? <Mic className="h-5 w-5 text-white" /> : <MessageSquare className="h-5 w-5 text-white" />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
