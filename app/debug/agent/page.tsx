"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth"
import { get, ref as dbRef, set } from "firebase/database"
import { auth, database } from "@/lib/firebase"
import { useAuth, type RegisterData } from "@/lib/auth-context"
import { useUserProfileContext, type UserProfile } from "@/lib/context"
import { useOmnamStore } from "@/lib/omnam-store"
import { RealtimeSession } from "@/lib/realtime/session"
import { ChromaAvatar } from "@/components/realtime/ChromaAvatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { MessageSender, type LiveAvatarSessionMessage } from "@/lib/liveavatar/types"
import { createDebugToolDispatcher } from "@/lib/debug-agent/dispatcher"
import {
  deriveCheckpoints,
  makeDebugEvent,
  type DebugCheckpoint,
  type DebugEvent,
  type DebugTranscriptMessage,
} from "@/lib/debug-agent/types"
import { toDebugRecord } from "@/lib/debug-agent/serialize"

type DebugIdentity = Omit<RegisterData, "password"> & {
  createdAt: string
  lastSeenAt: string
}

type DebugGuestRecord = {
  identity?: DebugIdentity
  activeSession?: unknown
  sessions?: Record<string, unknown>
  debug?: unknown
}

const DEFAULT_REGISTER: RegisterData = {
  email: "debug.manual@omnam.test",
  password: "Debug!2345",
  firstName: "Debug",
  lastName: "Guest",
  phoneNumber: "+44 7700 900000",
  dateOfBirth: "1990-01-01",
  nationality: "British",
  languagePreference: "en",
}

function fmtTime(ts?: number) {
  if (!ts) return "-"
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function profileSummary(profile: UserProfile) {
  const gc = profile.guestComposition
  return {
    dates: [profile.startDate, profile.endDate]
      .map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? new Date(d).toISOString().slice(0, 10) : ""))
      .filter(Boolean)
      .join(" to "),
    party: gc ? `${gc.adults ?? 0} adults, ${gc.children ?? 0} children${gc.childrenAges?.length ? `, ages ${gc.childrenAges.join(", ")}` : ""}` : "",
    purpose: profile.travelPurpose ?? "",
    interests: profile.interests.join(", "),
    budget: profile.budgetRange ?? "",
  }
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-white/40">{label}</p>
      <p className="mt-1 text-sm text-white/85">{value || "-"}</p>
    </div>
  )
}

function CheckpointTable({ checkpoints }: { checkpoints: DebugCheckpoint[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/5 text-left text-[11px] uppercase tracking-wider text-white/40">
          <tr>
            <th className="px-3 py-2">Checkpoint</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Value</th>
            <th className="px-3 py-2">Collected</th>
          </tr>
        </thead>
        <tbody>
          {checkpoints.map((cp) => (
            <tr key={cp.id} className="border-t border-white/5">
              <td className="px-3 py-2 text-white/80">
                {cp.label}
                {cp.required && <span className="ml-1 text-amber-300">*</span>}
              </td>
              <td className="px-3 py-2">
                <Badge
                  variant="outline"
                  className={
                    cp.status === "collected"
                      ? "border-emerald-400/30 text-emerald-300"
                      : cp.status === "not_applicable"
                        ? "border-white/20 text-white/50"
                        : "border-amber-400/30 text-amber-300"
                  }
                >
                  {cp.status.replace("_", " ")}
                </Badge>
              </td>
              <td className="max-w-[24rem] px-3 py-2 text-white/65">{cp.value || "-"}</td>
              <td className="px-3 py-2 text-white/45">{cp.collectedAt ? `${fmtTime(cp.collectedAt)}${cp.turnIndex ? ` / turn ${cp.turnIndex}` : ""}` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function DebugAgentPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<RealtimeSession | null>(null)
  const { logout, isAuthenticated, isAuthReady, firebaseUser } = useAuth()
  const { profile, updateProfile } = useUserProfileContext()
  const { state, dispatch, stateRef } = useOmnamStore()

  const [email, setEmail] = useState(DEFAULT_REGISTER.email)
  const [password, setPassword] = useState(DEFAULT_REGISTER.password)
  const [firstName, setFirstName] = useState(DEFAULT_REGISTER.firstName)
  const [lastName, setLastName] = useState(DEFAULT_REGISTER.lastName)
  const [status, setStatus] = useState("idle")
  const [error, setError] = useState<string | null>(null)
  const [chatText, setChatText] = useState("")
  const [messages, setMessages] = useState<LiveAvatarSessionMessage[]>([])
  const [events, setEvents] = useState<DebugEvent[]>([])
  const [persisted, setPersisted] = useState<DebugGuestRecord | null>(null)
  const [debugIdentity, setDebugIdentity] = useState<DebugIdentity | null>(null)
  const [sessionId, setSessionId] = useState("pending-debug-session")

  useEffect(() => {
    setSessionId(crypto.randomUUID())
  }, [])

  const addEvent = useCallback((event: DebugEvent) => {
    setEvents((prev) => [...prev, event])
  }, [])

  const transcriptMessages = useMemo<DebugTranscriptMessage[]>(
    () =>
      messages.map((m) => ({
        sender: m.sender === MessageSender.USER ? "user" : "ava",
        message: m.message,
        timestamp: m.timestamp,
      })),
    [messages],
  )
  const checkpoints = useMemo(() => deriveCheckpoints(profile, transcriptMessages, events), [profile, transcriptMessages, events])
  const latestMessages = useMemo(() => messages.slice().reverse(), [messages])

  const refreshPersisted = useCallback(async () => {
    const uid = auth?.currentUser?.uid
    if (!uid || !database) return
    const snap = await get(dbRef(database, `omnamDebug/users/${uid}`))
    const record = snap.exists() ? (snap.val() as DebugGuestRecord) : null
    setPersisted(record)
    if (record?.identity) {
      setDebugIdentity(record.identity)
      syncIdentityToProfile(record.identity)
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return
    void refreshPersisted()
    const timer = window.setInterval(() => void refreshPersisted(), 3000)
    return () => window.clearInterval(timer)
  }, [isAuthenticated, refreshPersisted])

  const markDebugUser = useCallback(async (mode: "manual" | "synthetic", debugRunId?: string) => {
    const uid = auth?.currentUser?.uid
    if (!database || !uid) return
    await set(dbRef(database, `omnamDebug/users/${uid}/debug`), toDebugRecord({
      mode,
      debugRunId: debugRunId ?? "manual-agent-debug",
      isSynthetic: mode === "synthetic",
      updatedAt: new Date().toISOString(),
    })).catch(() => {})
  }, [])

  const syncIdentityToProfile = useCallback((identity: DebugIdentity | null | undefined) => {
    if (!identity) return
    updateProfile({
      firstName: identity.firstName,
      lastName: identity.lastName,
      email: identity.email,
      phoneNumber: identity.phoneNumber,
      dateOfBirth: identity.dateOfBirth ? new Date(identity.dateOfBirth) : undefined,
      nationality: identity.nationality,
      languagePreference: identity.languagePreference,
    })
  }, [updateProfile])

  const writeDebugIdentity = useCallback(async (uid: string, data: Omit<DebugIdentity, "createdAt" | "lastSeenAt">, existingCreatedAt?: string) => {
    if (!database) throw new Error("Firebase database not configured")
    const now = new Date().toISOString()
    const identity: DebugIdentity = {
      ...data,
      email: data.email.toLowerCase().trim(),
      createdAt: existingCreatedAt ?? now,
      lastSeenAt: now,
    }
    await set(dbRef(database, `omnamDebug/users/${uid}/identity`), toDebugRecord(identity))
    setDebugIdentity(identity)
    syncIdentityToProfile(identity)
    return identity
  }, [syncIdentityToProfile])

  useEffect(() => {
    const uid = auth?.currentUser?.uid
    if (!database || !uid || sessionId === "pending-debug-session") return
    const payload = toDebugRecord({
      sessionId,
      updatedAt: new Date().toISOString(),
      profile,
      transcript: transcriptMessages,
      checkpoints,
      events,
      roomPlan: state.currentRoomPlan,
    })
    set(dbRef(database, `omnamDebug/users/${uid}/activeSession`), payload).catch(() => {})
    set(dbRef(database, `omnamDebug/users/${uid}/sessions/${sessionId}`), payload).catch(() => {})
  }, [checkpoints, events, profile, sessionId, state.currentRoomPlan, transcriptMessages])

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      if (!auth) throw new Error("Firebase auth not configured")
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password)
      await writeDebugIdentity(credential.user.uid, {
        email,
        firstName,
        lastName,
        phoneNumber: DEFAULT_REGISTER.phoneNumber,
        dateOfBirth: DEFAULT_REGISTER.dateOfBirth,
        nationality: DEFAULT_REGISTER.nationality,
        languagePreference: DEFAULT_REGISTER.languagePreference,
      })
      await markDebugUser("manual")
      addEvent(makeDebugEvent("session_started", "Debug user registered", email))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      if (!auth) throw new Error("Firebase auth not configured")
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password)
      let existingCreatedAt: string | undefined
      if (database) {
        const snap = await get(dbRef(database, `omnamDebug/users/${credential.user.uid}/identity`))
        const existing = snap.exists() ? (snap.val() as DebugIdentity) : null
        existingCreatedAt = existing?.createdAt
      }
      await writeDebugIdentity(credential.user.uid, {
        email,
        firstName,
        lastName,
        phoneNumber: DEFAULT_REGISTER.phoneNumber,
        dateOfBirth: DEFAULT_REGISTER.dateOfBirth,
        nationality: DEFAULT_REGISTER.nationality,
        languagePreference: DEFAULT_REGISTER.languagePreference,
      }, existingCreatedAt)
      await markDebugUser("manual")
      addEvent(makeDebugEvent("session_started", "Debug user logged in", email))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const recordTranscript = useCallback((who: "user" | "ava", text: string) => {
    const clean = text.trim()
    if (!clean) return
    const msg: LiveAvatarSessionMessage = {
      sender: who === "user" ? MessageSender.USER : MessageSender.AVATAR,
      message: clean,
      timestamp: Date.now(),
    }
    setMessages((prev) => [...prev, msg])
    addEvent(makeDebugEvent(who === "user" ? "transcript_user" : "transcript_ava", who === "user" ? "Guest said" : "Ava said", clean))
  }, [addEvent])

  const startAva = useCallback(async () => {
    if (!videoRef.current || sessionRef.current) return
    setError(null)
    setStatus("starting")
    const session = new RealtimeSession(
      videoRef.current,
      {
        onStatus: setStatus,
        onLog: (line) => addEvent(makeDebugEvent("tool_called", "Session log", line)),
        onTranscript: recordTranscript,
      },
      { greetOnReady: true },
    )
    session.setToolHandler(
      createDebugToolDispatcher({
        addEvent,
        saveProfile: (updates) => dispatch({ type: "UPDATE_PROFILE", updates }),
        setRoomPlan: (plan) => dispatch({ type: "SET_ROOM_PLAN", plan }),
        getPartySize: () => {
          const gc = stateRef.current.profile.guestComposition
          const n = (gc?.adults ?? 0) + (gc?.children ?? 0)
          return n > 0 ? n : undefined
        },
      }),
    )
    sessionRef.current = session
    addEvent(makeDebugEvent("session_started", "Ava debug session started", `sessionId=${sessionId}`))
    await session.start()
  }, [addEvent, dispatch, recordTranscript, sessionId, stateRef])

  const stopAva = useCallback(async () => {
    await sessionRef.current?.stop()
    sessionRef.current = null
    const uid = firebaseUser?.uid ?? null
    if (database && uid) {
      await set(dbRef(database, `omnamDebug/users/${uid}/sessions/${sessionId}/endedAt`), new Date().toISOString()).catch(() => {})
    }
    await fetch("/api/debug-agent/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toDebugRecord({
        runId: "manual-agent-debug",
        sessionId,
        kind: "manual",
        payload: {
          firebaseUid: uid,
          transcript: transcriptMessages,
          checkpoints,
          events,
          profile,
          persisted,
        },
      })),
    }).catch(() => {})
    addEvent(makeDebugEvent("session_completed", "Ava debug session stopped", `sessionId=${sessionId}`))
    setStatus("stopped")
  }, [addEvent, checkpoints, events, firebaseUser?.uid, persisted, profile, sessionId, transcriptMessages])

  const sendChat = useCallback(() => {
    const text = chatText.trim()
    if (!text || !sessionRef.current) return
    recordTranscript("user", text)
    sessionRef.current.injectContext(text, { respond: true })
    setChatText("")
  }, [chatText, recordTranscript])

  const summary = profileSummary(profile)

  if (!isAuthReady) {
    return <div className="flex min-h-screen items-center justify-center bg-[#0a0a12] text-white/50">Loading...</div>
  }

  return (
    <div className="min-h-screen bg-[#0a0a12] text-white">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0a0a12]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-sm font-semibold text-white/90">Ava Debug Agent</h1>
            <p className="text-xs text-white/40">No Unreal. Real OpenAI Realtime, HeyGen, Firebase.</p>
          </div>
          {isAuthenticated && (
            <Button variant="outline" className="border-white/20 text-white/70" onClick={() => void logout()}>
              Sign out
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-6 py-6 lg:grid-cols-[360px_1fr]">
        <div className="space-y-5">
          <Card className="border-white/10 bg-white/5">
            <CardHeader><CardTitle className="text-base text-white/90">Quick Auth</CardTitle></CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={handleLogin}>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} className="border-white/20 bg-white/10 text-white" />
                <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="border-white/20 bg-white/10 text-white" />
                <div className="grid grid-cols-2 gap-2">
                  <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="border-white/20 bg-white/10 text-white" />
                  <Input value={lastName} onChange={(e) => setLastName(e.target.value)} className="border-white/20 bg-white/10 text-white" />
                </div>
                {error && <p className="text-xs text-red-300">{error}</p>}
                <div className="flex gap-2">
                  <Button type="submit" disabled={isAuthenticated}>Login</Button>
                  <Button type="button" variant="outline" className="border-white/20 text-white/70" disabled={isAuthenticated} onClick={(e) => void handleRegister(e as unknown as FormEvent)}>
                    Register
                  </Button>
                </div>
              </form>
              <p className="mt-3 text-xs text-white/35">{firebaseUser?.uid ?? "No Firebase user"}</p>
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5">
            <CardHeader><CardTitle className="text-base text-white/90">Ava</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="overflow-hidden rounded-lg bg-black" style={{ width: 300, height: 360 }}>
                <ChromaAvatar videoRef={videoRef} fit="cover" style={{ width: "100%", height: "100%" }} />
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-white/20 text-white/70">{status}</Badge>
                <span className="text-xs text-white/35">session {sessionId.slice(0, 8)}</span>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => void startAva()} disabled={!isAuthenticated || !!sessionRef.current}>Start Ava</Button>
                <Button variant="outline" className="border-white/20 text-white/70" onClick={() => void stopAva()} disabled={!sessionRef.current}>Stop + Flush</Button>
              </div>
              <div className="flex gap-2">
                <Input
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendChat() }}
                  placeholder="Type to Ava"
                  className="border-white/20 bg-white/10 text-white"
                />
                <Button onClick={sendChat} disabled={!sessionRef.current}>Send</Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="border-white/10 bg-white/5">
            <CardHeader><CardTitle className="text-base text-white/90">Current Profile</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <Field label="Identity" value={debugIdentity ? `${debugIdentity.firstName} ${debugIdentity.lastName}` : "-"} />
              <Field label="Dates" value={summary.dates} />
              <Field label="Party" value={summary.party} />
              <Field label="Purpose" value={summary.purpose} />
              <Field label="Budget" value={summary.budget} />
              <Field label="Interests" value={summary.interests} />
              <Field label="Persisted sessions" value={persisted?.sessions ? Object.keys(persisted.sessions).length : 0} />
              <Field label="Debug namespace" value="omnamDebug" />
              <Field label="Returning hints" value="debug-only" />
              <Field label="Room plan" value={state.currentRoomPlan ? `$${state.currentRoomPlan.totalPerNight}/night, sleeps ${state.currentRoomPlan.capacity}` : "-"} />
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5">
            <CardHeader><CardTitle className="text-base text-white/90">Checkpoint Timeline</CardTitle></CardHeader>
            <CardContent><CheckpointTable checkpoints={checkpoints} /></CardContent>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card className="border-white/10 bg-white/5">
              <CardHeader><CardTitle className="text-base text-white/90">Transcript</CardTitle></CardHeader>
              <CardContent className="max-h-[30rem] space-y-2 overflow-y-auto">
                {latestMessages.map((msg, i) => (
                  <div key={`${msg.timestamp}-${i}`} className={msg.sender === MessageSender.USER ? "text-right" : "text-left"}>
                    <div className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm ${msg.sender === MessageSender.USER ? "bg-indigo-500/20 text-indigo-100" : "bg-white/10 text-white/80"}`}>
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-white/35">{msg.sender === MessageSender.USER ? "Guest" : "Ava"} / {fmtTime(msg.timestamp)}</p>
                      {msg.message}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-white/5">
              <CardHeader><CardTitle className="text-base text-white/90">Events</CardTitle></CardHeader>
              <CardContent className="max-h-[30rem] space-y-2 overflow-y-auto">
                {events.slice().reverse().map((event) => (
                  <div key={event.id} className="rounded-lg border border-white/10 bg-black/20 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="border-white/15 text-white/60">{event.type}</Badge>
                      <span className="text-[11px] text-white/35">{fmtTime(event.timestamp)}</span>
                    </div>
                    <p className="mt-1 text-sm text-white/80">{event.label}</p>
                    {event.detail && <p className="mt-1 text-xs text-white/45">{event.detail}</p>}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card className="border-white/10 bg-white/5">
            <CardHeader><CardTitle className="text-base text-white/90">Firebase Debug Paths</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs text-white/50">
              <p><code>omnamDebug/users/{firebaseUser?.uid ?? "{uid}"}/identity</code></p>
              <p><code>omnamDebug/users/{firebaseUser?.uid ?? "{uid}"}/sessions/{sessionId}</code></p>
              <p><code>omnamDebug/users/{firebaseUser?.uid ?? "{uid}"}/activeSession</code></p>
              <p><code>debug-conversations/manual-agent-debug/*.json</code></p>
              <Separator className="bg-white/10" />
              <pre className="max-h-72 overflow-auto rounded bg-black/30 p-3 text-[11px] text-white/55">
                {JSON.stringify(toDebugRecord({ persisted, profile, checkpoints }), null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
