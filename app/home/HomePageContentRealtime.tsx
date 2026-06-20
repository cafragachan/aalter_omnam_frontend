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

export default function HomePageContentRealtime() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<RealtimeSession | null>(null)
  const { state, dispatch } = useOmnamStore()
  const { userProfile, returningUserData } = useAuth()
  const currentRoomPlan = state.currentRoomPlan

  // Live mirror so the tool dispatcher (created once at start) reads the CURRENT
  // profile (e.g. party size) rather than the empty profile captured at start.
  const stateRef = useRef(state)
  stateRef.current = state

  // Persist the session (profile + guest intelligence) to Firebase so returning
  // guests accumulate data. DI hooks supply an empty transcript (the realtime
  // transcript isn't in LiveAvatarContext); profile/personality still persist.
  useIncrementalPersistence({
    useContext: () => ({ messages: [] }),
    useProfile: () => ({ userMessages: [] }),
  })

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

  // UE5 tap → drive the reducer (focus + select-if-new) AND tell Ava. When the
  // tap carries an `id` (new UE5 contract) it mutates the selection buckets; the
  // injectContext keeps Ava aware so she can comment naturally.
  const onUnitSelected = useCallback((payload: { id?: number; roomName: string }) => {
    if (typeof payload.id === "number") dispatch({ type: "TAP_UNIT", unitId: payload.id })
    sessionRef.current?.injectContext(
      `[context] The guest tapped ${payload.roomName} in the scene.`, { respond: true })
  }, [dispatch])

  // Arrival + planner gating refs. We hold the room recommendation until the live
  // unit inventory has actually arrived, so the first proposal resolves to real
  // units at real prices (no empty auto-resolve race). A timeout is a backstop so
  // Ava still proposes if UE5 never sends inventory (e.g. pre-merge / fallback).
  const atHotelRef = useRef(false)
  const plannerNudgedRef = useRef(false)
  const invTimerRef = useRef<number | null>(null)

  // Release the planner gate ONCE per arrival: nudge Ava to recommend rooms.
  // `signal` distinguishes the happy path (live inventory loaded) from the
  // fallback (backstop fired because no inventory ever arrived).
  const releasePlannerGate = useCallback((signal: "loaded" | "fallback") => {
    if (!atHotelRef.current || plannerNudgedRef.current) return
    plannerNudgedRef.current = true
    if (invTimerRef.current) { window.clearTimeout(invTimerRef.current); invTimerRef.current = null }
    const lead = signal === "loaded"
      ? "[room availability loaded] You now have the live unit list."
      : "[arrived]"
    sessionRef.current?.injectContext(
      `${lead} Recommend the best room(s) for their party by calling propose_room_plan (capacity MUST fit everyone), and mention they can also explore the amenities or the surrounding area.`,
      { respond: true })
  }, [])

  // Arm/replace the planner backstop — fires the fallback nudge if no inventory
  // arrives in `ms` (covers a UE5 that never reports levelLoaded / can't export).
  const armPlannerBackstop = useCallback((ms: number) => {
    if (invTimerRef.current) window.clearTimeout(invTimerRef.current)
    invTimerRef.current = window.setTimeout(() => {
      invTimerRef.current = null
      releasePlannerGate("fallback")
    }, ms)
  }, [releasePlannerGate])

  // UE5 inventory push → normalize + store. When the FIRST non-empty inventory
  // lands after arrival, feed Ava a compact table AND release the planner gate
  // (respond:true) so she recommends rooms against real availability. Empty
  // payloads (UE5 polled before the hotel level finished loading) are ignored.
  const onUnitInventory = useCallback((rawUnits: unknown[]) => {
    const units = normalizeInventory(rawUnits)
    dispatch({ type: "SET_UNIT_INVENTORY", units })
    if (units.length === 0) return
    const lines = units.map((u) =>
      `#${u.id} ${u.roomTypeId} L${u.level}${u.view ? " " + u.view : ""} $${u.price} ${u.available ? "avail" : "booked"}`)
    sessionRef.current?.injectContext(
      `[unit inventory] ${units.length} units in the scene:\n${lines.join("\n")}`, { respond: false })
    releasePlannerGate("loaded")
  }, [dispatch, releasePlannerGate])

  const ue5 = useUE5Bridge({ onUnitSelected, onUnitInventory })

  // Live mirror of UE5 readiness so the dispatcher (created once at start) can
  // poll the CURRENT value rather than the false captured at session start.
  const ue5ReadyRef = useRef(false)
  useEffect(() => {
    ue5ReadyRef.current = ue5.isReady
  }, [ue5.isReady])

  // Hotel level fully loaded (units now exist) → pull the live inventory. This is
  // the RELIABLE trigger: arrival fires while the map is still loading, so it's
  // too early. If we're at the hotel, (re)arm a short backstop in case UE5 reports
  // levelLoaded but can't export inventory.
  const ue5RequestInventory = ue5.requestInventory
  const ue5LevelLoadedSeq = ue5.levelLoadedSeq
  useEffect(() => {
    if (ue5LevelLoadedSeq <= 0) return
    ue5RequestInventory()
    if (atHotelRef.current) armPlannerBackstop(5000)
  }, [ue5LevelLoadedSeq, ue5RequestInventory, armPlannerBackstop])

  // Single authoritative emit: send the reconciled unit selection to UE5. Once
  // an inventory has arrived we emit the unit-level `selectUnits` (green set +
  // focused unit); before that we keep the legacy type-level `selectedRoom`
  // highlight as a graceful fallback so nothing breaks pre-UE5-merge. Re-emitting
  // on `scene` preserves the old "re-signal on entering rooms" behavior.
  const { unitSelection, unitInventory } = state
  const ue5SelectUnits = ue5.selectUnits
  const ue5SelectRoom = ue5.selectRoom
  const selKey = useMemo(
    () => `${selectedUnitIds(unitSelection).join(",")}|${unitSelection.activeUnitId ?? ""}`,
    [unitSelection])
  useEffect(() => {
    if (unitInventory.length > 0) {
      const ids = selectedUnitIds(unitSelection)
      ue5SelectUnits(ids, unitSelection.activeUnitId)   // unit-level (new UE5)
    } else if (currentRoomPlan?.rooms.length) {
      // FALLBACK pre-inventory: keep the old type-level highlight so nothing breaks.
      ue5SelectRoom(Array.from(new Set(currentRoomPlan.rooms.map((r) => r.roomId))).join(","))
    }
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

  const start = useCallback(async () => {
    if (!videoRef.current || sessionRef.current) return
    setActive(true)
    const session = new RealtimeSession(
      videoRef.current,
      {
        // Feed both spoken and typed turns into one shared transcript so the
        // chat view shows a continuous history (one bubble per finished turn).
        onTranscript: (who, text) => {
          const t = text.trim()
          if (t) setTranscript((prev) => [...prev, { who, text: t }])
        },
      },
      { greetOnReady: true },
    )
    session.setToolHandler(
      createToolDispatcher(ue5, {
        onScene: setScene,
        saveProfile: (updates) => dispatch({ type: "UPDATE_PROFILE", updates }),
        setRoomPlan: (plan) => dispatch({ type: "SET_ROOM_PLAN", plan }),
        onRoomsPanel: setShowRoomsPanel,
        onArrived: (arrived: boolean) => {
          setAtHotel(arrived)
          atHotelRef.current = arrived
          if (invTimerRef.current) { window.clearTimeout(invTimerRef.current); invTimerRef.current = null }
          if (arrived) {
            plannerNudgedRef.current = false
            // Don't pull inventory here — the hotel map is still loading. The pull
            // happens on UE5's `levelLoaded` signal (see effect above). Arm a
            // generous backstop only for the degraded case where UE5 never reports
            // levelLoaded / can't export inventory, so Ava still proposes.
            armPlannerBackstop(10000)
          }
        },
        getPartySize: () => {
          const gc = stateRef.current.profile.guestComposition
          const n = (gc?.adults ?? 0) + (gc?.children ?? 0)
          return n > 0 ? n : undefined
        },
        isUe5Ready: () => ue5ReadyRef.current,
        notify: (text) => sessionRef.current?.injectContext(text, { respond: true }),
        getInventory: () => stateRef.current.unitInventory,
        selectUnits: (unitIds) => dispatch({ type: "AI_SELECT_UNITS", unitIds }),
        setActiveUnit: (unitId) => dispatch({ type: "SET_ACTIVE_UNIT", unitId }),
      }),
    )
    sessionRef.current = session
    // Queue hydration before the WS opens; flushed on open. respond:false — Ava
    // greets ONCE on the guest's first turn (proactive auto-greet caused a
    // double welcome), and the persona still drives the intake.
    if (hydration) session.injectContext(hydration, { respond: false })
    await session.start()
  }, [ue5, dispatch, hydration, userProfile])

  // Auto-start once the avatar's <video> is mounted — no "Begin" gate. The
  // avatar and the mic/Realtime start INDEPENDENTLY (see RealtimeSession.start),
  // so a getUserMedia/permission hiccup never tears the avatar down to black.
  // start() is idempotent (guards on sessionRef), and the cleanup stops the
  // session, so React StrictMode's mount→unmount→mount only yields one live
  // session.
  useEffect(() => {
    void start()
    const onUnload = () => {
      void sessionRef.current?.stop()
    }
    window.addEventListener("beforeunload", onUnload)
    return () => {
      window.removeEventListener("beforeunload", onUnload)
      void sessionRef.current?.stop()
      sessionRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    setTranscript((prev) => [...prev, { who: "user", text: t }])
    sessionRef.current.injectContext(t, { respond: true })
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" onDragStart={(e) => e.preventDefault()}>
      {/* Rooms panel — right side */}
      {showRoomsPanel && (
        <div className="pointer-events-auto fixed right-4 top-4 bottom-[calc(4rem+2vh)] z-20" style={{ width: 273 }}>
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

      {/* Avatar control panel — bottom-left glass pill (always mounted so the
          session can attach to the avatar video). */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col px-6 pb-10">
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
                <ChatPanel messages={transcript} onSend={onSendChat} width={300} height={262} />
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
