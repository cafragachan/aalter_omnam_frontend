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

  const [active, setActive] = useState(false)
  const [status, setStatus] = useState("idle")
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)
  const [scene, setScene] = useState("lounge")
  const [transcript, setTranscript] = useState<{ who: string; text: string }[]>([])

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
    if (name) parts.push(`The returning guest's name is ${name}.`)
    if (userProfile?.nationality) parts.push(`Nationality: ${userProfile.nationality}.`)
    if (prefs) parts.push(`Previously noted preferences: ${safeJson(prefs)}.`)
    return `[returning guest] ${parts.join(" ")} Greet them warmly${name ? " by name" : ""} and tailor the experience to what you already know.`
  }, [userProfile, returningUserData])

  const onUnitSelected = useCallback((payload: { roomName: string }) => {
    sessionRef.current?.injectContext(`[context] The guest just selected the ${payload.roomName} unit in the scene.`, { respond: true })
  }, [])

  const ue5 = useUE5Bridge({ onUnitSelected })

  const selectRoomUE5 = ue5.selectRoom
  const lastSelectedPayloadRef = useRef<string | null>(null)
  useEffect(() => {
    const entries = currentRoomPlan?.rooms ?? []
    if (entries.length === 0) return
    const ids = Array.from(new Set(entries.map((r) => r.roomId)))
    const payload = ids.join(",")
    if (!payload || lastSelectedPayloadRef.current === payload) return
    lastSelectedPayloadRef.current = payload
    selectRoomUE5(payload)
  }, [currentRoomPlan, selectRoomUE5])

  const start = useCallback(async () => {
    if (!videoRef.current || sessionRef.current) return
    setActive(true)
    const session = new RealtimeSession(videoRef.current, {
      onStatus: setStatus,
      onMetric: (_m: TurnMetric) => {},
      onTranscript: (who, text) => setTranscript((prev) => [...prev, { who, text }].slice(-30)),
    })
    session.setToolHandler(
      createToolDispatcher(ue5, {
        onScene: setScene,
        saveProfile: (updates) => dispatch({ type: "UPDATE_PROFILE", updates }),
        setRoomPlan: (plan) => dispatch({ type: "SET_ROOM_PLAN", plan }),
        onRoomsPanel: setShowRoomsPanel,
      }),
    )
    sessionRef.current = session
    // Queue hydration before the WS opens; flushed on open (proactive welcome
    // back for returning guests).
    if (hydration) session.injectContext(hydration, { respond: Boolean(userProfile?.firstName) })
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
