"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RealtimeSession } from "@/lib/realtime/session"
import { createToolDispatcher } from "@/lib/realtime/dispatcher"
import { PILOT_HOTEL_SLUG } from "@/lib/realtime/context"
import { useUE5Bridge } from "@/lib/ue5/bridge"
import { useOmnamStore } from "@/lib/omnam-store"
import { RoomsPanel } from "@/components/panels/RoomsPanel"
import { ChromaAvatar } from "@/components/realtime/ChromaAvatar"
import { getHotelBySlug, getRoomsByHotelId, type RoomPlan, type RoomPlanEntry } from "@/lib/hotel-data"
import { useAuth } from "@/lib/auth-context"
import { useIncrementalPersistence } from "@/lib/firebase/useIncrementalPersistence"
import { SunToggle } from "@/components/SunToggle"
import { Volume2, VolumeX, MessageSquare, Send } from "lucide-react"
import { MessageSender, type LiveAvatarSessionMessage } from "@/lib/liveavatar/types"

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

  const [active, setActive] = useState(false)
  const [atHotel, setAtHotel] = useState(false)
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)
  const [scene, setScene] = useState("lounge")
  const [muted, setMuted] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatText, setChatText] = useState("")
  const [messages, setMessages] = useState<LiveAvatarSessionMessage[]>([])

  // Persist the session (profile + guest intelligence) to Firebase so returning
  // guests accumulate data. The realtime transcript is captured from
  // RealtimeSession callbacks and fed through the same persistence hook.
  useIncrementalPersistence({
    useContext: () => ({ messages }),
    useProfile: () => ({
      userMessages: messages
        .filter((m) => m.sender === MessageSender.USER)
        .map((m) => ({ message: m.message, timestamp: m.timestamp })),
    }),
  })

  const recordTranscript = useCallback((who: "user" | "ava", text: string) => {
    const clean = text.trim()
    if (!clean) return
    setMessages((prev) => [
      ...prev,
      {
        sender: who === "user" ? MessageSender.USER : MessageSender.AVATAR,
        message: clean,
        timestamp: Date.now(),
      },
    ])
  }, [])

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
    return {
      entries,
      totalCapacity: entries.reduce((s, e) => s + e.occupancy * e.quantity, 0),
      totalPricePerNight: entries.reduce((s, e) => s + e.pricePerNight * e.quantity, 0),
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

  const onUnitSelected = useCallback((payload: { roomName: string }) => {
    sessionRef.current?.injectContext(`[context] The guest just selected the ${payload.roomName} unit in the scene.`, { respond: true })
  }, [])

  const ue5 = useUE5Bridge({ onUnitSelected })

  // Live mirror of UE5 readiness so the dispatcher (created once at start) can
  // poll the CURRENT value rather than the false captured at session start.
  const ue5ReadyRef = useRef(false)
  useEffect(() => {
    ue5ReadyRef.current = ue5.isReady
  }, [ue5.isReady])

  const selectRoomUE5 = ue5.selectRoom
  const lastSelectedPayloadRef = useRef<string | null>(null)
  // GUEST-driven plan edits (panel cards) — always re-send the unit array so UE5
  // restays in sync. (Planner proposals are highlighted by the dispatcher, which
  // gates them behind UE5's post-travel/scene settle.)
  useEffect(() => {
    const plan = currentRoomPlan
    if (!plan || plan.source !== "user") return
    const ids = Array.from(new Set(plan.rooms.map((r) => r.roomId)))
    const payload = ids.join(",")
    lastSelectedPayloadRef.current = payload
    selectRoomUE5(payload)
  }, [currentRoomPlan, selectRoomUE5])

  // Re-signal the highlighted units whenever we (re-)enter the rooms scene, so
  // they persist even if the plan was set before arrival or after a detour.
  useEffect(() => {
    if (scene !== "rooms") return
    const ids = Array.from(new Set((currentRoomPlan?.rooms ?? []).map((r) => r.roomId)))
    if (!ids.length) return
    const payload = ids.join(",")
    lastSelectedPayloadRef.current = payload
    selectRoomUE5(payload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

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
      { onTranscript: recordTranscript },
      { greetOnReady: true },
    )
    session.setToolHandler(
      createToolDispatcher(ue5, {
        onScene: setScene,
        saveProfile: (updates) => dispatch({ type: "UPDATE_PROFILE", updates }),
        setRoomPlan: (plan) => dispatch({ type: "SET_ROOM_PLAN", plan }),
        onRoomsPanel: setShowRoomsPanel,
        onArrived: setAtHotel,
        getPartySize: () => {
          const gc = stateRef.current.profile.guestComposition
          const n = (gc?.adults ?? 0) + (gc?.children ?? 0)
          return n > 0 ? n : undefined
        },
        isUe5Ready: () => ue5ReadyRef.current,
        notify: (text) => sessionRef.current?.injectContext(text, { respond: true }),
      }),
    )
    sessionRef.current = session
    // Queue hydration before the WS opens; flushed on open. respond:false — Ava
    // greets ONCE on the guest's first turn (proactive auto-greet caused a
    // double welcome), and the persona still drives the intake.
    if (hydration) session.injectContext(hydration, { respond: false })
    await session.start()
  }, [ue5, dispatch, hydration, userProfile, recordTranscript])

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

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m
      if (videoRef.current) videoRef.current.muted = next
      return next
    })
  }, [])
  const sendChat = useCallback(() => {
    const text = chatText.trim()
    if (!text || !sessionRef.current) return
    sessionRef.current.injectContext(text, { respond: true })
    setChatText("")
  }, [chatText])

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
          {active && chatOpen && (
            <div className="pointer-events-auto mb-3 flex w-full max-w-sm gap-2">
              <input
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendChat()
                }}
                placeholder="Type to Ava…"
                className="flex-1 rounded-xl border border-white/25 bg-white/15 px-3 py-2 text-sm text-white outline-none backdrop-blur-md placeholder:text-white/50"
              />
              <button
                onClick={sendChat}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 backdrop-blur-md transition-colors hover:bg-white/20"
              >
                <Send className="h-5 w-5 text-white" />
              </button>
            </div>
          )}
          <div className="pointer-events-auto inline-flex items-stretch rounded-[20px] border border-white/25 bg-gradient-to-br from-white/20 via-white/10 to-white/5 shadow-[0_20px_60px_-28px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
            {/* Avatar thumbnail (chroma-keyed onto black) */}
            <div className="p-[5px] pr-0">
              <div className="relative overflow-hidden rounded-[16px] bg-black shadow-2xl" style={{ width: 210, height: 262 }}>
                <ChromaAvatar videoRef={videoRef} fit="cover" style={{ width: "100%", height: "100%" }} />
              </div>
            </div>

            {/* Right body — vertical button column */}
            <div className="flex min-w-[70px] flex-col items-center justify-end gap-3 px-[15px] py-4">
              {/* Lighting toggle is a hotel-scene control — hidden in the lounge
                  (at start and after returning from the experience). */}
              {atHotel && <SunToggle value={ue5.sunState} onChange={ue5.changeSunPosition} />}
              {active && (
                <>
                  <button
                    onClick={toggleMute}
                    title={muted ? "Unmute Ava" : "Mute Ava"}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-lg backdrop-blur-md transition-colors hover:bg-white/20"
                  >
                    {muted ? <VolumeX className="h-5 w-5 text-red-400" /> : <Volume2 className="h-5 w-5 text-white" />}
                  </button>
                  <button
                    onClick={() => setChatOpen((o) => !o)}
                    title="Type to Ava"
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-lg backdrop-blur-md transition-colors hover:bg-white/20"
                  >
                    <MessageSquare className="h-5 w-5 text-white" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
