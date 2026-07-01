"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth"
import { ref as dbRef, set, update } from "firebase/database"
import { auth, database } from "@/lib/firebase"
import type { UserProfile } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { DEBUG_SCENARIOS, type DebugScenario } from "@/lib/debug-agent/scenarios"
import { TextRealtimeSession } from "@/lib/debug-agent/text-realtime-session"
import { createDebugToolDispatcher } from "@/lib/debug-agent/dispatcher"
import {
  deriveDebugBookingGate,
  makeDebugEvent,
  type DebugGate,
  type DebugEvent,
  type DebugTranscriptMessage,
} from "@/lib/debug-agent/types"
import { toDebugRecord } from "@/lib/debug-agent/serialize"

type RunStatus = "queued" | "registering" | "starting" | "chatting" | "completed" | "failed"

type ScenarioRun = {
  scenario: DebugScenario
  status: RunStatus
  uid?: string
  sessionId: string
  transcript: DebugTranscriptMessage[]
  events: DebugEvent[]
  profile: UserProfile
  roomPlan: CurrentRoomPlan | null
  error?: string
  summary?: string
}

type SimDiagnostic = {
  type: "missing_fact" | "premature_room_plan" | "blocked_booking" | "ready_for_recap"
  label: string
  detail: string
  severity: "info" | "warning"
}

const MAX_AGENT_RUNS = 10
const emptyProfile = (): UserProfile => ({ interests: [], startDate: null, endDate: null })

function clampAgentCount(value: number) {
  return Math.max(1, Math.min(MAX_AGENT_RUNS, Math.floor(value) || 1))
}

function makeScenarioRun(scenario: DebugScenario): ScenarioRun {
  return {
    scenario,
    status: "queued",
    sessionId: typeof crypto === "undefined" ? `pending-${scenario.id}` : crypto.randomUUID(),
    transcript: [],
    events: [],
    profile: emptyProfile(),
    roomPlan: null,
  }
}

function shuffleScenarioRuns(runs: ScenarioRun[]) {
  const next = runs.slice()
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next[i], next[j]] = [next[j], next[i]]
  }
  return next
}

function mergeProfile(prev: UserProfile, updates: Partial<UserProfile>): UserProfile {
  const guestComposition = updates.guestComposition
    ? { ...(prev.guestComposition ?? {}), ...updates.guestComposition }
    : prev.guestComposition
  return {
    ...prev,
    ...updates,
    guestComposition,
    interests: Array.from(new Set([...(prev.interests ?? []), ...(updates.interests ?? [])])),
    dietaryRestrictions: Array.from(new Set([...(prev.dietaryRestrictions ?? []), ...(updates.dietaryRestrictions ?? [])])),
    accessibilityNeeds: Array.from(new Set([...(prev.accessibilityNeeds ?? []), ...(updates.accessibilityNeeds ?? [])])),
    amenityPriorities: Array.from(new Set([...(prev.amenityPriorities ?? []), ...(updates.amenityPriorities ?? [])])),
  }
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function statusClass(status: RunStatus) {
  switch (status) {
    case "completed": return "border-emerald-400/30 text-emerald-300"
    case "failed": return "border-red-400/30 text-red-300"
    case "chatting": return "border-indigo-400/30 text-indigo-300"
    default: return "border-white/20 text-white/55"
  }
}

function gateScore(gates: DebugGate[]) {
  const required = gates.filter((gate) => gate.required)
  const done = required.filter((gate) => gate.status === "ready" || gate.status === "not_required" || gate.status === "waiting")
  return { done: done.length, total: required.length, pct: required.length ? (done.length / required.length) * 100 : 0 }
}

function deriveDiagnostics(
  gate: ReturnType<typeof deriveDebugBookingGate>,
  roomPlan: CurrentRoomPlan | null,
): SimDiagnostic[] {
  const diagnostics: SimDiagnostic[] = []
  const missing = gate.gates.filter((item) => item.required && item.status === "missing")

  for (const item of missing) {
    diagnostics.push({
      type: "missing_fact",
      label: "Missing fact",
      detail: item.label,
      severity: "warning",
    })
  }

  if (roomPlan && !gate.decision.readiness.canRecommendRooms.allowed) {
    diagnostics.push({
      type: "premature_room_plan",
      label: "Room plan before recommendation-ready facts",
      detail: gate.decision.readiness.canRecommendRooms.reason,
      severity: "warning",
    })
  }

  if (!gate.decision.readiness.canPrepareBooking.allowed) {
    diagnostics.push({
      type: "blocked_booking",
      label: "Booking preflight blocked",
      detail: gate.decision.readiness.canPrepareBooking.reason,
      severity: missing.length ? "warning" : "info",
    })
  }

  if (gate.decision.nextAction.type === "PRESENT_FINAL_RECAP") {
    diagnostics.push({
      type: "ready_for_recap",
      label: "Ready for final recap",
      detail: gate.decision.nextAction.reason,
      severity: "info",
    })
  }

  return diagnostics
}

export default function AgentSimulationPage() {
  const [runId, setRunId] = useState("debug-run")
  const [runCount, setRunCount] = useState(() => Math.min(5, MAX_AGENT_RUNS, DEBUG_SCENARIOS.length))
  const [runs, setRuns] = useState<ScenarioRun[]>(() => DEBUG_SCENARIOS.map(makeScenarioRun))
  const [active, setActive] = useState(false)
  const [mounted, setMounted] = useState(false)
  const stopRef = useRef(false)

  useEffect(() => {
    setMounted(true)
    setRunId(`debug-run-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    setRuns((prev) => prev.map((run) => ({ ...run, sessionId: crypto.randomUUID() })))
  }, [])

  const selectedRuns = useMemo(() => runs.slice(0, clampAgentCount(runCount)), [runCount, runs])

  const overall = useMemo(() => {
    const completed = selectedRuns.filter((r) => r.status === "completed").length
    const failed = selectedRuns.filter((r) => r.status === "failed").length
    return { completed, failed, pct: selectedRuns.length ? ((completed + failed) / selectedRuns.length) * 100 : 0 }
  }, [selectedRuns])

  const patchRun = useCallback((scenarioId: string, patch: Partial<ScenarioRun> | ((run: ScenarioRun) => Partial<ScenarioRun>)) => {
    setRuns((prev) =>
      prev.map((run) => {
        if (run.scenario.id !== scenarioId) return run
        const nextPatch = typeof patch === "function" ? patch(run) : patch
        return { ...run, ...nextPatch }
      }),
    )
  }, [])

  const writeRun = useCallback(async (scenarioId: string, patch: Record<string, unknown>) => {
    if (!database) return
    await update(dbRef(database, `omnamDebug/debugRuns/${runId}/scenarios/${scenarioId}`), toDebugRecord({
      ...patch,
      updatedAt: new Date().toISOString(),
    }) as Record<string, unknown>).catch(() => {})
  }, [runId])

  const appendEvent = useCallback((scenarioId: string, event: DebugEvent) => {
    patchRun(scenarioId, (run) => ({ events: [...run.events, event] }))
  }, [patchRun])

  const appendTranscript = useCallback((scenarioId: string, sender: "user" | "ava", message: string) => {
    const item: DebugTranscriptMessage = { sender, message, timestamp: Date.now() }
    patchRun(scenarioId, (run) => ({ transcript: [...run.transcript, item] }))
  }, [patchRun])

  const persistSnapshot = useCallback(async (run: ScenarioRun) => {
    if (!database) return
    const bookingGate = deriveDebugBookingGate(run.profile, run.roomPlan)
    const diagnostics = deriveDiagnostics(bookingGate, run.roomPlan)
    const payload = toDebugRecord({
      scenarioId: run.scenario.id,
      displayName: run.scenario.displayName,
      behavior: {
        experienceLevel: run.scenario.experienceLevel,
        guidanceNeed: run.scenario.guidanceNeed,
        disclosureStyle: run.scenario.disclosureStyle,
        frictionStyle: run.scenario.frictionStyle,
        expectedCheckpointPath: run.scenario.expectedCheckpointPath,
      },
      status: run.status,
      uid: run.uid ?? null,
      sessionId: run.sessionId,
      isSynthetic: true,
      debugRunId: runId,
      transcript: run.transcript,
      events: run.events,
      profile: run.profile,
      expected: run.scenario.tripFacts,
      bookingGate,
      diagnostics,
      roomPlan: run.roomPlan,
      error: run.error ?? null,
      updatedAt: new Date().toISOString(),
    })
    await set(dbRef(database, `omnamDebug/debugRuns/${runId}/scenarios/${run.scenario.id}`), payload).catch(() => {})
    await fetch("/api/debug-agent/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        scenarioId: run.scenario.id,
        sessionId: run.sessionId,
        kind: "synthetic",
        payload,
      }),
    }).catch(() => {})
  }, [runId])

  const getLatestRun = useCallback((scenarioId: string) => {
    return new Promise<ScenarioRun>((resolve) => {
      setRuns((prev) => {
        const run = prev.find((r) => r.scenario.id === scenarioId)
        if (run) resolve(run)
        return prev
      })
    })
  }, [])

  const ensureAuth = useCallback(async (scenario: DebugScenario) => {
    try {
      patchRun(scenario.id, { status: "registering" })
      if (!auth) throw new Error("Firebase auth not configured")
      const credential = await createUserWithEmailAndPassword(auth, scenario.email, scenario.password)
      const identity = {
        email: scenario.email,
        ...scenario.identity,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }
      if (database) {
        await set(dbRef(database, `omnamDebug/users/${credential.user.uid}/identity`), toDebugRecord(identity))
      }
      await writeRun(scenario.id, { identity, email: scenario.email, status: "registering" })
    } catch {
      if (!auth) throw new Error("Firebase auth not configured")
      const credential = await signInWithEmailAndPassword(auth, scenario.email, scenario.password)
      if (database) {
        await update(dbRef(database, `omnamDebug/users/${credential.user.uid}/identity`), toDebugRecord({
          email: scenario.email,
          ...scenario.identity,
          lastSeenAt: new Date().toISOString(),
        }) as Record<string, unknown>).catch(() => {})
      }
    }
    const uid = auth?.currentUser?.uid
    if (database && uid) {
      await update(dbRef(database, `omnamDebug/users/${uid}/debug`), toDebugRecord({
        mode: "synthetic",
        isSynthetic: true,
        debugRunId: runId,
        scenarioId: scenario.id,
        updatedAt: new Date().toISOString(),
      }) as Record<string, unknown>).catch(() => {})
    }
    patchRun(scenario.id, { uid })
    return uid
  }, [patchRun, runId, writeRun])

  const askSyntheticCustomer = useCallback(async (scenario: DebugScenario, transcript: DebugTranscriptMessage[]) => {
    const res = await fetch("/api/debug-agent/customer-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario, transcript }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || "customer reply failed")
    return String(json.reply ?? "").trim()
  }, [])

  const runScenario = useCallback(async (initial: ScenarioRun) => {
    const scenario = initial.scenario
    try {
      const uid = await ensureAuth(scenario)
      patchRun(scenario.id, { status: "starting" })
      appendEvent(scenario.id, makeDebugEvent("session_started", "Synthetic session started", `uid=${uid ?? "unknown"}`))

      let profile = emptyProfile()
      let roomPlan: CurrentRoomPlan | null = null
      let transcript: DebugTranscriptMessage[] = []
      let events: DebugEvent[] = []

      const addEvent = (event: DebugEvent) => {
        events = [...events, event]
        appendEvent(scenario.id, event)
      }
      const addTranscript = (sender: "user" | "ava", message: string) => {
        const item = { sender, message, timestamp: Date.now() }
        transcript = [...transcript, item]
        appendTranscript(scenario.id, sender, message)
      }

      const session = new TextRealtimeSession({
        onStatus: (status) => appendEvent(scenario.id, makeDebugEvent("tool_called", "Realtime status", status)),
        onLog: (line) => appendEvent(scenario.id, makeDebugEvent("tool_called", "Realtime log", line)),
        onTranscript: addTranscript,
      })
      session.setToolHandler(
        createDebugToolDispatcher({
          addEvent,
          saveProfile: (updates) => {
            profile = mergeProfile(profile, updates)
            patchRun(scenario.id, { profile })
          },
          setRoomPlan: (plan) => {
            roomPlan = plan
            patchRun(scenario.id, { roomPlan })
          },
          getPartySize: () => {
            const gc = profile.guestComposition
            const n = (gc?.adults ?? 0) + (gc?.children ?? 0)
            return n > 0 ? n : undefined
          },
          injectSkill: (id, reason, opts) => session.injectSkill(id, reason, opts),
        }),
      )

      await session.start()
      patchRun(scenario.id, { status: "chatting" })

      let customerText = scenario.openingMessage
      for (let turn = 0; turn < 8; turn++) {
        if (stopRef.current) break
        const avaReply = await session.sendUserText(customerText)
        await new Promise((resolve) => setTimeout(resolve, 250))
        const currentRun = await getLatestRun(scenario.id)
        await persistSnapshot({ ...currentRun, profile, transcript, events, roomPlan, status: "chatting" })
        if (roomPlan && scenario.stopCondition === "room_plan_proposed") {
          customerText = "That sounds helpful. Thank you, this gives me enough to compare the options."
          await session.sendUserText(customerText).catch(() => "")
          break
        }
        customerText = await askSyntheticCustomer(scenario, [...transcript, { sender: "ava", message: avaReply, timestamp: Date.now() }])
        if (!customerText) break
      }

      session.stop()
      const finalRun = await getLatestRun(scenario.id)
      const bookingGate = deriveDebugBookingGate(profile, roomPlan)
      const diagnostics = deriveDiagnostics(bookingGate, roomPlan)
      const missing = bookingGate.gates.filter((gate) => gate.required && gate.status === "missing").map((gate) => gate.label)
      const warningCount = diagnostics.filter((d) => d.severity === "warning").length
      const summary = missing.length
        ? `Missing: ${missing.join(", ")}`
        : warningCount
          ? `Booking gate ready; ${warningCount} warning${warningCount === 1 ? "" : "s"}.`
          : `Booking gate next action: ${bookingGate.decision.nextAction.type.replace(/_/g, " ")}.`
      patchRun(scenario.id, { status: "completed", profile, transcript, events, roomPlan, summary })
      await persistSnapshot({ ...finalRun, status: "completed", profile, transcript, events, roomPlan, summary })
      appendEvent(scenario.id, makeDebugEvent("session_completed", "Synthetic session completed", summary))
    } catch (err) {
      const message = (err as Error).message
      patchRun(scenario.id, { status: "failed", error: message })
      appendEvent(scenario.id, makeDebugEvent("session_failed", "Synthetic session failed", message))
      await writeRun(scenario.id, { status: "failed", error: message })
    }
  }, [appendEvent, appendTranscript, askSyntheticCustomer, ensureAuth, getLatestRun, patchRun, persistSnapshot, writeRun])

  const startBatch = useCallback(async () => {
    setActive(true)
    stopRef.current = false
    const count = Math.min(clampAgentCount(runCount), DEBUG_SCENARIOS.length)
    const batchRuns = runs.slice(0, count).map((run) => makeScenarioRun(run.scenario))
    setRuns((prev) => [
      ...batchRuns,
      ...prev.filter((run) => !batchRuns.some((batchRun) => batchRun.scenario.id === run.scenario.id)),
    ])
    if (database) {
      await set(dbRef(database, `omnamDebug/debugRuns/${runId}`), toDebugRecord({
        runId,
        startedAt: new Date().toISOString(),
        isSynthetic: true,
        scenarioCount: count,
        requestedScenarioCount: runCount,
      })).catch(() => {})
    }
    for (const run of batchRuns) {
      if (stopRef.current) break
      await runScenario(run)
    }
    setActive(false)
  }, [runCount, runId, runScenario, runs])

  const stopBatch = useCallback(() => {
    stopRef.current = true
    setActive(false)
  }, [])

  const shuffleAgents = useCallback(() => {
    setRuns((prev) => shuffleScenarioRuns(prev))
  }, [])

  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a12] text-white/50">
        Loading synthetic customer monitor...
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a12] text-white">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0a0a12]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-sm font-semibold text-white/90">Ava Synthetic Customer Monitor</h1>
            <p className="text-xs text-white/40">Text-only customer bots. Real Ava Realtime session. Real Firebase writes.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="border-white/20 text-white/70" onClick={shuffleAgents} disabled={active}>Shuffle</Button>
            <Button onClick={() => void startBatch()} disabled={active}>Run {selectedRuns.length} customers</Button>
            <Button variant="outline" className="border-white/20 text-white/70" onClick={stopBatch} disabled={!active}>Stop</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-6 py-6">
        <Card className="border-white/10 bg-white/5">
          <CardContent className="flex flex-wrap items-center gap-4 pt-6">
            <div className="min-w-[18rem] flex-1">
              <p className="text-xs uppercase tracking-wider text-white/40">Debug run ID</p>
              <input
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
                disabled={active}
                className="mt-1 w-full rounded border border-white/15 bg-black/25 px-3 py-2 text-sm text-white"
              />
            </div>
            <div className="w-40">
              <p className="text-xs uppercase tracking-wider text-white/40">Agents to run</p>
              <input
                type="number"
                min={1}
                max={MAX_AGENT_RUNS}
                value={runCount}
                onChange={(e) => setRunCount(clampAgentCount(Number(e.target.value)))}
                disabled={active}
                className="mt-1 w-full rounded border border-white/15 bg-black/25 px-3 py-2 text-sm text-white"
              />
              <p className="mt-1 text-[11px] text-white/35">Min 1, max {MAX_AGENT_RUNS}. Shuffle picks from the full scenario pool.</p>
            </div>
            <div className="w-64">
              <p className="mb-2 text-xs text-white/45">{overall.completed} completed, {overall.failed} failed</p>
              <Progress value={overall.pct} className="h-2 bg-white/10" />
            </div>
            <p className="text-xs text-white/40"><code>omnamDebug/debugRuns/{runId}</code></p>
          </CardContent>
        </Card>

        <div className="grid gap-5">
          {selectedRuns.map((run) => {
            const bookingGate = deriveDebugBookingGate(run.profile, run.roomPlan)
            const score = gateScore(bookingGate.gates)
            const diagnostics = deriveDiagnostics(bookingGate, run.roomPlan)
            return (
              <Card key={run.scenario.id} className="border-white/10 bg-white/5">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-base text-white/90">{run.scenario.displayName}</CardTitle>
                      <p className="mt-1 text-xs text-white/40">{run.scenario.speakingStyle}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge variant="outline" className="border-sky-400/25 text-sky-200">{run.scenario.experienceLevel}</Badge>
                        <Badge variant="outline" className="border-violet-400/25 text-violet-200">{run.scenario.guidanceNeed} guidance</Badge>
                        <Badge variant="outline" className="border-white/15 text-white/55">{run.scenario.disclosureStyle.replace(/_/g, " ")}</Badge>
                        <Badge variant="outline" className="border-white/15 text-white/55">{run.scenario.frictionStyle.replace(/_/g, " ")}</Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={statusClass(run.status)}>{run.status}</Badge>
                      <span className="text-xs text-white/35">{run.uid ?? run.scenario.email}</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                    <div className="space-y-2">
                      <p className="text-xs text-white/45">Required gates: {score.done}/{score.total}</p>
                      <Progress value={score.pct} className="h-2 bg-white/10" />
                      <p className="text-xs text-sky-200">Next action: {bookingGate.decision.nextAction.type.replace(/_/g, " ")}</p>
                      {run.roomPlan && <p className="text-xs text-emerald-300">Room plan: ${run.roomPlan.totalPerNight}/night, sleeps {run.roomPlan.capacity}</p>}
                      {run.summary && <p className="text-xs text-white/55">{run.summary}</p>}
                      {run.error && <p className="text-xs text-red-300">{run.error}</p>}
                      {diagnostics.length > 0 && (
                        <div className="space-y-1 rounded-lg border border-white/10 bg-black/20 p-2">
                          <p className="text-[11px] uppercase tracking-wider text-white/35">Diagnostics</p>
                          {diagnostics.slice(0, 5).map((diagnostic, i) => (
                            <p
                              key={`${diagnostic.type}-${i}`}
                              className={diagnostic.severity === "warning" ? "text-xs text-amber-300" : "text-xs text-white/50"}
                            >
                              {diagnostic.label}: {diagnostic.detail}
                            </p>
                          ))}
                          {diagnostics.length > 5 && <p className="text-xs text-white/35">+{diagnostics.length - 5} more</p>}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                      {bookingGate.gates.filter((gate) => gate.required).map((gate) => (
                        <div key={gate.id} className="rounded-lg border border-white/10 bg-black/20 p-2">
                          <p className="text-[11px] text-white/45">{gate.label}</p>
                          <p className={gate.status === "missing" ? "text-xs text-amber-300" : gate.status === "waiting" ? "text-xs text-sky-300" : "text-xs text-emerald-300"}>{gate.status.replace(/_/g, " ")}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-3">
                      <p className="mb-2 text-xs uppercase tracking-wider text-white/40">Transcript</p>
                      <div className="space-y-2">
                        {run.transcript.slice().reverse().map((msg, i) => (
                          <div key={`${msg.timestamp}-${i}`} className={msg.sender === "user" ? "text-right" : "text-left"}>
                            <div className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-xs ${msg.sender === "user" ? "bg-indigo-500/20 text-indigo-100" : "bg-white/10 text-white/80"}`}>
                              <span className="mb-1 block text-[10px] uppercase tracking-wider text-white/35">{msg.sender === "user" ? "Customer" : "Ava"} / {fmtTime(msg.timestamp)}</span>
                              {msg.message}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-3">
                      <p className="mb-2 text-xs uppercase tracking-wider text-white/40">Expected vs collected</p>
                      <pre className="text-[11px] leading-relaxed text-white/60">
                        {JSON.stringify(toDebugRecord({
                          behavior: {
                            experienceLevel: run.scenario.experienceLevel,
                            guidanceNeed: run.scenario.guidanceNeed,
                            disclosureStyle: run.scenario.disclosureStyle,
                            frictionStyle: run.scenario.frictionStyle,
                            expectedCheckpointPath: run.scenario.expectedCheckpointPath,
                          },
                          expected: run.scenario.tripFacts,
                          collected: run.profile,
                          bookingGate,
                          diagnostics,
                          events: run.events.slice(-8),
                        }), null, 2)}
                      </pre>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </main>
    </div>
  )
}
