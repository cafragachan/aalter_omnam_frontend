"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RealtimeSession, type TurnMetric } from "@/lib/realtime/session"
import { createToolDispatcher } from "@/lib/realtime/dispatcher"
import { formatSceneDelta, PILOT_HOTEL_SLUG } from "@/lib/realtime/context"
import { useUE5Bridge } from "@/lib/ue5/bridge"
import { useOmnamStore } from "@/lib/omnam-store"
import { RoomsPanel } from "@/components/panels/RoomsPanel"
import { ChromaAvatar } from "@/components/realtime/ChromaAvatar"
import { getHotelBySlug, getRoomsByHotelId, type RoomPlan, type RoomPlanEntry } from "@/lib/hotel-data"

// Walking skeleton: UE5 twin + HeyGen LITE avatar + gpt-realtime brain that
// navigates (function calls → UE5), remembers the guest (save_profile →
// OmnamStore), recommends a room plan (propose_room_plan → currentRoomPlan,
// which highlights rooms in UE5 and renders the RoomsPanel), and books
// (open_booking → book_url). Dev chrome lives in a LEFT column; the rooms panel
// occupies the RIGHT.

const STREAM_MODE = process.env.NEXT_PUBLIC_STREAM_MODE || "local"
const IS_VAGON = STREAM_MODE === "vagon"
const STREAM_URL = IS_VAGON
  ? "https://streams.vagon.io/streams/e92ad7d9-0510-4246-bdac-8fbedb5653ed?newSession=true"
  : process.env.NEXT_PUBLIC_VAGON_STREAM_URL || "http://127.0.0.1"
const IFRAME_ALLOW = IS_VAGON
  ? "microphone *; clipboard-read *; clipboard-write *; encrypted-media *; fullscreen *"
  : "autoplay; fullscreen; clipboard-read; clipboard-write; gamepad"

export default function RealtimeExperience() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<RealtimeSession | null>(null)
  const { state, dispatch } = useOmnamStore()
  const currentRoomPlan = state.currentRoomPlan
  const stateRef = useRef(state)
  stateRef.current = state

  const [active, setActive] = useState(false)
  const [status, setStatus] = useState("idle")
  const [scene, setScene] = useState("lounge")
  const [lastE2e, setLastE2e] = useState<number | null>(null)
  const [transcript, setTranscript] = useState<{ who: string; text: string }[]>([])
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [showRoomsPanel, setShowRoomsPanel] = useState(false)

  // Static catalog for the pilot hotel (full Room[] for the panel).
  const { rooms, hotelName } = useMemo(() => {
    const hotel = getHotelBySlug(PILOT_HOTEL_SLUG)
    return { rooms: hotel ? getRoomsByHotelId(hotel.id) : [], hotelName: hotel?.name ?? "the hotel" }
  }, [])

  // currentRoomPlan (store) → RoomPlan (panel prop). Mirrors app/home/page.tsx.
  const recommendedPlan = useMemo<RoomPlan | null>(() => {
    if (!currentRoomPlan || currentRoomPlan.rooms.length === 0) return null
    const byId = new Map(rooms.map((r) => [r.id, r]))
    const entries: RoomPlanEntry[] = []
    for (const entry of currentRoomPlan.rooms) {
      const room = byId.get(entry.roomId)
      if (!room) continue
      entries.push({
        roomId: room.id,
        roomName: room.name,
        quantity: entry.quantity,
        pricePerNight: room.price,
        occupancy: parseInt(room.occupancy, 10) || 0,
      })
    }
    if (entries.length === 0) return null
    return {
      entries,
      totalCapacity: entries.reduce((s, e) => s + e.occupancy * e.quantity, 0),
      totalPricePerNight: entries.reduce((s, e) => s + e.pricePerNight * e.quantity, 0),
    }
  }, [currentRoomPlan, rooms])

  const pushLog = useCallback((line: string) => {
    const ts = new Date().toLocaleTimeString()
    setLog((prev) => [`${ts}  ${line}`, ...prev].slice(0, 150))
  }, [])

  // In-world unit click → tell Ava so she reacts (proactive narration). L3.
  const onUnitSelected = useCallback((payload: { roomName: string }) => {
    sessionRef.current?.injectContext(
      formatSceneDelta(`the ${payload.roomName} unit (the guest just selected it in the scene)`),
      { respond: true },
    )
  }, [])

  const ue5 = useUE5Bridge({ onUnitSelected })

  // currentRoomPlan → UE5 selectedRoom highlight (deduped). Mirrors /home.
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
      onLog: pushLog,
      onMetric: (m: TurnMetric) => setLastE2e(m.e2eMs),
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
    await session.start()
  }, [pushLog, ue5, dispatch])

  const stop = useCallback(async () => {
    await sessionRef.current?.stop()
    sessionRef.current = null
    setActive(false)
  }, [])

  // Reliability: tear down the LITE + Realtime session on unmount and tab close.
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

  // EDIT_ROOM_PLAN wiring for the RoomsPanel cards (user-driven edits).
  const onAddRoom = useCallback((roomId: string) => dispatch({ type: "EDIT_ROOM_PLAN", edit: { kind: "add", roomId } }), [dispatch])
  const onSetRoomQuantity = useCallback((roomId: string, quantity: number) => dispatch({ type: "EDIT_ROOM_PLAN", edit: { kind: "setQuantity", roomId, quantity } }), [dispatch])
  const onRemoveRoom = useCallback((roomId: string) => dispatch({ type: "EDIT_ROOM_PLAN", edit: { kind: "remove", roomId } }), [dispatch])

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", color: "#e7e9ee", fontFamily: "system-ui, sans-serif" }}>
      <iframe
        title="UE5 Stream"
        src={STREAM_URL}
        allow={IFRAME_ALLOW}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
      />

      {/* Controls (top-left) */}
      <div style={{ position: "absolute", top: 16, left: 16, zIndex: 10, display: "flex", gap: 10, alignItems: "center", background: "rgba(11,13,18,.8)", padding: "8px 12px", borderRadius: 10, backdropFilter: "blur(6px)" }}>
        {!active ? (
          <button onClick={start} style={btn("#2563eb")}>▶ Start</button>
        ) : (
          <button onClick={stop} style={btn("#b91c1c")}>■ Stop</button>
        )}
        <span style={{ fontSize: 12, opacity: 0.8 }}>{status}</span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>· scene: <strong>{scene}</strong></span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>
          · t0→t3:{" "}
          <strong style={{ color: lastE2e != null && lastE2e < 1000 ? "#34d399" : "#f87171" }}>
            {lastE2e != null ? `${Math.round(lastE2e)}ms` : "—"}
          </strong>
        </span>
        <button onClick={() => setShowLog((v) => !v)} style={btn("#334155")}>{showLog ? "Hide log" : "Log"}</button>
        <button onClick={() => setShowRoomsPanel((v) => !v)} style={btn("#334155")}>Rooms</button>
        {!ue5.isConnected && <span style={{ fontSize: 12, color: "#fbbf24" }}>UE5 ⚠ not connected</span>}
      </div>

      {/* LEFT column (bottom-anchored): [log?] → transcript → avatar */}
      <div style={{ position: "absolute", left: 16, top: 64, bottom: 16, width: 320, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 10, pointerEvents: "none" }}>
        {showLog && (
          <div style={{ ...card(), flex: 1, minHeight: 0, overflow: "auto", fontFamily: "ui-monospace, monospace", fontSize: 11, pointerEvents: "auto" }}>
            <strong style={{ opacity: 0.7 }}>Event log</strong>
            {log.map((l, i) => (
              <div key={i} style={{ whiteSpace: "pre-wrap", opacity: 0.9 }}>{l}</div>
            ))}
          </div>
        )}
        <div style={{ ...card(), maxHeight: 220, overflow: "auto", pointerEvents: "auto" }}>
          <strong style={{ opacity: 0.7, fontSize: 12 }}>Transcript</strong>
          {transcript.length === 0 && <div style={{ opacity: 0.4, fontSize: 12 }}>…speak to Ava…</div>}
          {transcript.map((t, i) => (
            <div key={i} style={{ margin: "3px 0", fontSize: 12 }}>
              <span style={{ color: t.who === "ava" ? "#60a5fa" : "#a3e635" }}>{t.who === "ava" ? "Ava" : "You"}:</span> {t.text}
            </div>
          ))}
        </div>
        {/* Chroma-keyed avatar — composites over the twin (transparent bg) */}
        <ChromaAvatar videoRef={videoRef} fit="contain" style={{ width: 300, height: 420, pointerEvents: "none" }} />
      </div>

      {/* RIGHT: rooms panel (driven by currentRoomPlan; cards edit the plan) */}
      <div style={{ position: "absolute", right: 16, top: 16, bottom: 16, width: 380, zIndex: 10, pointerEvents: showRoomsPanel ? "auto" : "none" }}>
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
    </div>
  )
}

function card(): React.CSSProperties {
  return { background: "rgba(20,24,35,.92)", border: "1px solid #232838", borderRadius: 10, padding: 12, backdropFilter: "blur(6px)" }
}
function btn(bg: string): React.CSSProperties {
  return { background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" }
}
