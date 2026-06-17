"use client"

import { useCallback, useRef, useState } from "react"
import { RealtimeSession, type TurnMetric } from "@/lib/realtime/session"

// Phase A walking skeleton: HeyGen LITE avatar + gpt-realtime brain, with a dev
// HUD (status, last end-to-end latency, transcript, event log). No UE5 yet (A.2).

export default function RealtimeAvatar() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<RealtimeSession | null>(null)

  const [active, setActive] = useState(false)
  const [status, setStatus] = useState("idle")
  const [lastE2e, setLastE2e] = useState<number | null>(null)
  const [transcript, setTranscript] = useState<{ who: string; text: string }[]>([])
  const [log, setLog] = useState<string[]>([])

  const pushLog = useCallback((line: string) => {
    const ts = new Date().toLocaleTimeString()
    setLog((prev) => [`${ts}  ${line}`, ...prev].slice(0, 150))
  }, [])

  const start = useCallback(async () => {
    if (!videoRef.current || sessionRef.current) return
    setActive(true)
    const session = new RealtimeSession(videoRef.current, {
      onStatus: setStatus,
      onLog: pushLog,
      onMetric: (m: TurnMetric) => setLastE2e(m.e2eMs),
      onTranscript: (who, text) =>
        setTranscript((prev) => [...prev, { who, text }].slice(-30)),
    })
    sessionRef.current = session
    await session.start()
  }, [pushLog])

  const stop = useCallback(async () => {
    await sessionRef.current?.stop()
    sessionRef.current = null
    setActive(false)
  }, [])

  return (
    <main style={{ display: "flex", gap: 20, padding: 20, minHeight: "100vh", background: "#0b0d12", color: "#e7e9ee", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ flex: "0 0 520px", display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Omnam Realtime — Phase A (LITE + gpt-realtime)</h1>
        <div style={{ width: 520, height: 520, background: "#000", borderRadius: 12, overflow: "hidden" }}>
          <video ref={videoRef} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {!active ? (
            <button onClick={start} style={btn("#2563eb")}>▶ Start</button>
          ) : (
            <button onClick={stop} style={btn("#b91c1c")}>■ Stop</button>
          )}
          <span style={{ fontSize: 13, opacity: 0.8 }}>status: {status}</span>
          <span style={{ marginLeft: "auto", fontSize: 13 }}>
            last t0→t3:{" "}
            <strong style={{ color: lastE2e != null && lastE2e < 1000 ? "#34d399" : "#f87171" }}>
              {lastE2e != null ? `${Math.round(lastE2e)}ms` : "—"}
            </strong>
          </span>
        </div>
        <div style={card()}>
          <strong style={{ opacity: 0.7, fontSize: 13 }}>Transcript</strong>
          {transcript.length === 0 && <div style={{ opacity: 0.4, fontSize: 13 }}>…speak to Ava…</div>}
          {transcript.map((t, i) => (
            <div key={i} style={{ margin: "4px 0", fontSize: 13 }}>
              <span style={{ color: t.who === "ava" ? "#60a5fa" : "#a3e635" }}>{t.who === "ava" ? "Ava" : "You"}:</span> {t.text}
            </div>
          ))}
        </div>
      </div>
      <div style={{ ...card(), flex: 1, overflow: "auto", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
        <strong style={{ opacity: 0.7 }}>Event log</strong>
        {log.map((l, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", opacity: 0.9 }}>{l}</div>
        ))}
      </div>
    </main>
  )
}

function card(): React.CSSProperties {
  return { background: "#141823", border: "1px solid #232838", borderRadius: 10, padding: 12 }
}
function btn(bg: string): React.CSSProperties {
  return { background: bg, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontSize: 15, fontWeight: 700, cursor: "pointer" }
}
