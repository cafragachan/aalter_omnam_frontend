"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RealtimeSession, type TurnMetric } from "@/lib/realtime/session"
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

function fmtDate(d: unknown): string | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d as string)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
function tripDates(p: { startDate?: unknown; endDate?: unknown }): string {
  const s = fmtDate(p.startDate)
  const e = fmtDate(p.endDate)
  if (s && e) return `${s} – ${e}`
  if (s) return `from ${s}`
  return "—"
}
function tripGuests(p: { guestComposition?: { adults?: number; children?: number } }): string {
  const gc = p.guestComposition
  if (!gc || (gc.adults == null && gc.children == null)) return "—"
  const a = gc.adults ?? 0
  const c = gc.children ?? 0
  return `${a} adult${a === 1 ? "" : "s"}${c > 0 ? ` · ${c} child${c === 1 ? "" : "ren"}` : ""}`
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 40,
  height: 40,
  borderRadius: 999,
  background: "rgba(255,255,255,.15)",
  border: "1px solid rgba(255,255,255,.3)",
  color: "#fff",
  cursor: "pointer",
  backdropFilter: "blur(8px)",
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
  const [status, setStatus] = useState("idle")
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)
  const [scene, setScene] = useState("lounge")
  const [transcript, setTranscript] = useState<{ who: string; text: string }[]>([])
  const [muted, setMuted] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatText, setChatText] = useState("")

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
    const session = new RealtimeSession(videoRef.current, {
      onStatus: setStatus,
      onMetric: (_m: TurnMetric) => {},
      onTranscript: (who, text) => setTranscript((prev) => [...prev, { who, text }].slice(-30)),
    }, { greetOnReady: true })
    session.setToolHandler(
      createToolDispatcher(ue5, {
        onScene: setScene,
        saveProfile: (updates) => dispatch({ type: "UPDATE_PROFILE", updates }),
        setRoomPlan: (plan) => dispatch({ type: "SET_ROOM_PLAN", plan }),
        onRoomsPanel: setShowRoomsPanel,
        getPartySize: () => {
          const gc = stateRef.current.profile.guestComposition
          const n = (gc?.adults ?? 0) + (gc?.children ?? 0)
          return n > 0 ? n : undefined
        },
      }),
    )
    sessionRef.current = session
    // Queue hydration before the WS opens; flushed on open. respond:false — Ava
    // greets ONCE on the guest's first turn (proactive auto-greet caused a
    // double welcome), and the persona still drives the intake.
    if (hydration) session.injectContext(hydration, { respond: false })
    await session.start()
  }, [ue5, dispatch, hydration, userProfile])

  useEffect(() => {
    const onUnload = () => {
      void sessionRef.current?.stop()
    }
    window.addEventListener("beforeunload", onUnload)
    return () => {
      window.removeEventListener("beforeunload", onUnload)
      void sessionRef.current?.stop()
      sessionRef.current = null
    }
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
    setTranscript((prev) => [...prev, { who: "user", text }].slice(-30))
    setChatText("")
  }, [chatText])

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 20, pointerEvents: "none" }}>
      {/* Start gate (mic needs a user gesture) */}
      {!active && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto" }}>
          <button onClick={start} style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 12, padding: "14px 28px", fontSize: 18, fontWeight: 800, cursor: "pointer", boxShadow: "0 10px 40px rgba(0,0,0,.5)" }}>
            ▶ Begin with Ava
          </button>
        </div>
      )}

      {/* Trip-details chip — fills in live as Ava captures the intake */}
      {active && (
        <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 14, alignItems: "center", background: "rgba(11,13,18,.78)", border: "1px solid #232838", borderRadius: 999, padding: "6px 18px", fontSize: 12, color: "#e7e9ee", pointerEvents: "none", backdropFilter: "blur(6px)" }}>
          <span><span style={{ opacity: 0.55 }}>Dates</span> {tripDates(state.profile)}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span><span style={{ opacity: 0.55 }}>Guests</span> {tripGuests(state.profile)}</span>
        </div>
      )}

      {/* Chroma-keyed avatar + transcript, bottom-left */}
      <div style={{ position: "absolute", left: 16, bottom: 16, width: 340, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
        {active && transcript.length > 0 && (
          <div style={{ maxHeight: 160, overflow: "auto", background: "rgba(20,24,35,.85)", border: "1px solid #232838", borderRadius: 10, padding: 10, fontSize: 12, pointerEvents: "auto", backdropFilter: "blur(6px)" }}>
            {transcript.map((t, i) => (
              <div key={i} style={{ margin: "2px 0" }}>
                <span style={{ color: t.who === "ava" ? "#60a5fa" : "#a3e635" }}>{t.who === "ava" ? "Ava" : "You"}:</span> {t.text}
              </div>
            ))}
          </div>
        )}
        {active && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", pointerEvents: "auto" }}>
            <button onClick={toggleMute} title={muted ? "Unmute Ava" : "Mute Ava"} style={iconBtnStyle}>
              {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <SunToggle value={ue5.sunState} onChange={ue5.changeSunPosition} />
            <button onClick={() => setChatOpen((o) => !o)} title="Type to Ava" style={iconBtnStyle}>
              <MessageSquare size={16} />
            </button>
          </div>
        )}
        {active && chatOpen && (
          <div style={{ display: "flex", gap: 6, pointerEvents: "auto" }}>
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendChat()
              }}
              placeholder="Type to Ava…"
              style={{ flex: 1, background: "rgba(20,24,35,.9)", border: "1px solid #232838", borderRadius: 8, padding: "6px 10px", color: "#e7e9ee", fontSize: 13, outline: "none" }}
            />
            <button onClick={sendChat} style={iconBtnStyle}>
              <Send size={16} />
            </button>
          </div>
        )}
        <ChromaAvatar videoRef={videoRef} fit="contain" style={{ width: 340, height: 460 }} />
      </div>

      {/* Rooms panel, right */}
      <div style={{ position: "absolute", right: 16, top: 16, bottom: 16, width: 380, pointerEvents: showRoomsPanel ? "auto" : "none" }}>
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

      {active && (
        <div style={{ position: "absolute", top: 12, left: 12, fontSize: 11, color: "#cbd5e1", background: "rgba(11,13,18,.7)", padding: "4px 8px", borderRadius: 8, pointerEvents: "none" }}>
          {status} · {scene}
        </div>
      )}
    </div>
  )
}
