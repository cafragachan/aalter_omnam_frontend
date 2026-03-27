"use client"

import { useState, useCallback, useRef, type FormEvent } from "react"
import { useAuth } from "@/lib/auth-context"
import {
  searchGuests,
  getGuestRecord,
  downloadSessionSnapshot,
  type GuestSearchResult,
  type GuestRecord,
} from "@/lib/firebase/admin-service"
import type { SessionSnapshot } from "@/lib/firebase/types"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
  } catch {
    return iso
  }
}

function fmtDateTime(iso: string | undefined | null): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "booked":
      return "text-emerald-400"
    case "abandoned":
      return "text-red-400"
    default:
      return "text-amber-400"
  }
}

function TagList({ items, emptyText = "None" }: { items: string[] | undefined | null; emptyText?: string }) {
  if (!items || items.length === 0) return <span className="text-sm text-white/40">{emptyText}</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item} variant="secondary" className="bg-white/10 text-white/80 border-white/10 text-xs">
          {item}
        </Badge>
      ))}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wider text-white/40">{label}</p>
      <p className="text-sm text-white/90">{value ?? "—"}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search Panel
// ---------------------------------------------------------------------------

function SearchPanel({
  results,
  loading,
  onSearch,
  onSelect,
  selectedUid,
}: {
  results: GuestSearchResult[]
  loading: boolean
  onSearch: (query: string) => void
  onSelect: (uid: string) => void
  selectedUid: string | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const q = inputRef.current?.value ?? ""
    if (q.trim()) onSearch(q.trim())
  }

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg text-white/90">Guest Search</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            ref={inputRef}
            placeholder="Search by name, surname, or email..."
            className="bg-white/10 border-white/20 text-white placeholder:text-white/30"
          />
          <Button type="submit" disabled={loading} className="shrink-0">
            {loading ? "Searching..." : "Search"}
          </Button>
        </form>

        {results.length > 0 && (
          <div className="rounded-xl border border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/5 text-left text-[11px] uppercase tracking-wider text-white/40">
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5 text-center">Sessions</th>
                  <th className="px-4 py-2.5">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {results.map((guest) => (
                  <tr
                    key={guest.uid}
                    onClick={() => onSelect(guest.uid)}
                    className={cn(
                      "cursor-pointer border-b border-white/5 transition-colors hover:bg-white/10",
                      selectedUid === guest.uid && "bg-white/10",
                    )}
                  >
                    <td className="px-4 py-3 text-white/90 font-medium">
                      {guest.identity.firstName} {guest.identity.lastName}
                    </td>
                    <td className="px-4 py-3 text-white/60">{guest.identity.email}</td>
                    <td className="px-4 py-3 text-center text-white/60">
                      {guest.loyalty?.totalSessions ?? 0}
                    </td>
                    <td className="px-4 py-3 text-white/50 text-xs">
                      {fmtDate(guest.identity.lastSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Guest Detail View
// ---------------------------------------------------------------------------

function GuestDetail({ guest }: { guest: GuestRecord }) {
  const { identity, personality, preferences, consent, loyalty, sessions } = guest

  return (
    <div className="space-y-4">
      {/* Identity + Loyalty row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IdentityCard identity={identity} />
        <LoyaltyCard loyalty={loyalty} />
      </div>

      {/* Personality */}
      {personality && <PersonalityCard personality={personality} />}

      {/* Preferences */}
      {preferences && <PreferencesCard preferences={preferences} />}

      {/* Consent */}
      {consent && <ConsentCard consent={consent} />}

      {/* Sessions */}
      {sessions && <SessionsPanel sessions={sessions} userId={guest.uid} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Identity Card
// ---------------------------------------------------------------------------

function IdentityCard({ identity }: { identity: GuestRecord["identity"] }) {
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-white/90 flex items-center gap-2">
          <span className="inline-block h-8 w-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 text-center text-sm font-bold leading-8 text-white">
            {identity.firstName?.[0]}
            {identity.lastName?.[0]}
          </span>
          {identity.firstName} {identity.lastName}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Field label="Email" value={identity.email} />
          <Field label="Phone" value={identity.phoneNumber} />
          <Field label="Date of Birth" value={fmtDate(identity.dateOfBirth)} />
          <Field label="Nationality" value={identity.nationality} />
          <Field label="Language" value={identity.languagePreference} />
          <Field label="Member Since" value={fmtDate(identity.createdAt)} />
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Loyalty Card
// ---------------------------------------------------------------------------

function LoyaltyCard({ loyalty }: { loyalty: GuestRecord["loyalty"] }) {
  if (!loyalty) {
    return (
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base text-white/90">Loyalty</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-white/40">No loyalty data yet</p></CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-white/90">Loyalty</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Field label="Tier" value={loyalty.tier ?? "Standard"} />
          <Field label="Total Sessions" value={loyalty.totalSessions} />
          <Field label="Total Bookings" value={loyalty.totalBookings} />
          <Field label="Lifetime Value" value={loyalty.lifetimeValue > 0 ? `$${loyalty.lifetimeValue.toLocaleString()}` : "—"} />
          <Field label="First Session" value={fmtDate(loyalty.firstSessionAt)} />
          <Field label="Last Session" value={fmtDate(loyalty.lastSessionAt)} />
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Personality Card
// ---------------------------------------------------------------------------

function PersonalityCard({ personality }: { personality: NonNullable<GuestRecord["personality"]> }) {
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-white/90">Personality & Intelligence</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Traits</p>
            <TagList items={personality.traits} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Travel Drivers</p>
            <TagList items={personality.travelDrivers} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Travel Purposes</p>
            <TagList items={personality.travelPurposes} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Interests</p>
            <TagList items={personality.interests} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Dietary Restrictions</p>
            <TagList items={personality.dietaryRestrictions} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Accessibility Needs</p>
            <TagList items={personality.accessibilityNeeds} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Amenity Priorities</p>
            <TagList items={personality.amenityPriorities} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Top Objections</p>
            <TagList items={personality.topObjectionTopics} />
          </div>
        </div>

        <Separator className="bg-white/10" />

        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Field label="Budget Tendency" value={personality.budgetTendency} />
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Upsell Receptivity</p>
            {personality.upsellReceptivity != null ? (
              <div className="flex items-center gap-3">
                <Progress value={personality.upsellReceptivity * 100} className="h-2 flex-1 bg-white/10" />
                <span className="text-sm text-white/70 tabular-nums">
                  {Math.round(personality.upsellReceptivity * 100)}%
                </span>
              </div>
            ) : (
              <span className="text-sm text-white/40">—</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Preferences Card
// ---------------------------------------------------------------------------

function PreferencesCard({ preferences }: { preferences: NonNullable<GuestRecord["preferences"]> }) {
  const guestComp = preferences.typicalGuestComposition

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-white/90">Preferences</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Preferred Room Types</p>
            <TagList items={preferences.preferredRoomTypes} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Preferred Destinations</p>
            <TagList items={preferences.preferredDestinations} />
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-white/40">Preferred Amenities</p>
            <TagList items={preferences.preferredAmenities} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Field
            label="Typical Guest Composition"
            value={guestComp ? `${guestComp.adults} adult${guestComp.adults !== 1 ? "s" : ""}${guestComp.children > 0 ? `, ${guestComp.children} child${guestComp.children !== 1 ? "ren" : ""}` : ""}` : null}
          />
          <Field
            label="Typical Stay Length"
            value={preferences.typicalStayLength ? `${preferences.typicalStayLength} night${preferences.typicalStayLength !== 1 ? "s" : ""}` : null}
          />
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Consent Card
// ---------------------------------------------------------------------------

function ConsentCard({ consent }: { consent: NonNullable<GuestRecord["consent"]> }) {
  const flags = [
    { label: "Marketing", value: consent.marketing },
    { label: "Data Sharing", value: consent.dataSharing },
    { label: "Analytics", value: consent.analytics },
    { label: "Third Party", value: consent.thirdParty },
  ]

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-white/90">Consent</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          {flags.map((flag) => (
            <div
              key={flag.label}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm",
                flag.value
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-red-500/30 bg-red-500/10 text-red-400",
              )}
            >
              <span>{flag.value ? "\u2713" : "\u2717"}</span>
              <span>{flag.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-white/30">Updated {fmtDateTime(consent.updatedAt)}</p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Sessions Panel (Accordion)
// ---------------------------------------------------------------------------

function SessionsPanel({
  sessions,
  userId,
}: {
  sessions: Record<string, import("@/lib/firebase/types").SessionPointer>
  userId: string
}) {
  const entries = Object.entries(sessions).sort(
    ([, a], [, b]) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  )

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-white/90">
          Session History ({entries.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="single" collapsible className="w-full">
          {entries.map(([sessionId, pointer]) => (
            <AccordionItem key={sessionId} value={sessionId} className="border-white/10">
              <AccordionTrigger className="text-white/80 hover:text-white hover:no-underline">
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{fmtDateTime(pointer.startedAt)}</span>
                  {pointer.hotel && (
                    <Badge variant="outline" className="border-white/20 text-white/60 text-xs">
                      {pointer.hotel}
                    </Badge>
                  )}
                  <Badge variant="outline" className="border-white/20 text-white/50 text-xs">
                    {pointer.journeyStage}
                  </Badge>
                  <span className={cn("text-xs font-medium", outcomeColor(pointer.bookingOutcome))}>
                    {pointer.bookingOutcome}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <SessionDetailLoader storagePath={pointer.storagePath} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Session Detail Loader (lazy-loads snapshot from Storage)
// ---------------------------------------------------------------------------

function SessionDetailLoader({ storagePath }: { storagePath: string }) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (loaded) return
    setLoading(true)
    setError(null)
    try {
      const data = await downloadSessionSnapshot(storagePath)
      setSnapshot(data)
      setLoaded(true)
    } catch (err) {
      setError("Failed to load session snapshot")
    } finally {
      setLoading(false)
    }
  }, [storagePath, loaded])

  if (!loaded) {
    return (
      <div className="py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          className="border-white/20 text-white/60 text-xs"
        >
          {loading ? "Loading snapshot..." : "Load Full Session Snapshot"}
        </Button>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    )
  }

  if (!snapshot) {
    return <p className="py-2 text-xs text-white/40">Snapshot not available</p>
  }

  return <SessionDetail snapshot={snapshot} />
}

// ---------------------------------------------------------------------------
// Session Detail (full snapshot view)
// ---------------------------------------------------------------------------

function SessionDetail({ snapshot }: { snapshot: SessionSnapshot }) {
  const gi = snapshot.guestIntelligence
  const messages = snapshot.conversationMessages ?? []

  return (
    <div className="space-y-4 py-2">
      {/* Exploration metrics */}
      {(gi.roomsExplored?.length > 0 || gi.amenitiesExplored?.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {gi.roomsExplored?.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider text-white/40">Rooms Explored</p>
              <div className="space-y-1">
                {gi.roomsExplored.map((r) => (
                  <div key={r.roomId} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs">
                    <span className="text-white/80">{r.roomId}</span>
                    <span className="text-white/40">{(r.timeSpentMs / 1000).toFixed(0)}s</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {gi.amenitiesExplored?.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider text-white/40">Amenities Explored</p>
              <div className="space-y-1">
                {gi.amenitiesExplored.map((a) => (
                  <div key={a.name} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs">
                    <span className="text-white/80">{a.name}</span>
                    <span className="text-white/40">{(a.timeSpentMs / 1000).toFixed(0)}s</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Objections */}
      {gi.objections?.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wider text-white/40">Objections Raised</p>
          <div className="flex flex-wrap gap-1.5">
            {gi.objections.map((o) => (
              <Badge key={o.topic} variant="outline" className={cn("text-xs", o.resolved ? "border-emerald-500/30 text-emerald-400" : "border-amber-500/30 text-amber-400")}>
                {o.topic} {o.resolved ? "(resolved)" : "(unresolved)"}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Conversation transcript */}
      {messages.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wider text-white/40">
            Conversation Transcript ({messages.length} messages)
          </p>
          <div className="max-h-80 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
            {messages.map((msg, i) => {
              const isUser = msg.sender === "USER" || msg.sender === "user"
              return (
                <div
                  key={i}
                  className={cn("flex", isUser ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[75%] rounded-2xl px-3 py-2 text-xs leading-relaxed",
                      isUser
                        ? "bg-indigo-500/20 text-indigo-200 rounded-br-sm"
                        : "bg-white/10 text-white/80 rounded-bl-sm",
                    )}
                  >
                    <p className="mb-0.5 text-[10px] font-medium opacity-50">
                      {isUser ? "Guest" : "Ava"}
                    </p>
                    {msg.message}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ===========================================================================
// Main Admin Page
// ===========================================================================

export default function AdminPage() {
  const { isAuthenticated, isAuthReady, firebaseUser } = useAuth()

  const [searchResults, setSearchResults] = useState<GuestSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedGuest, setSelectedGuest] = useState<GuestRecord | null>(null)
  const [loadingGuest, setLoadingGuest] = useState(false)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)

  const handleSearch = useCallback(async (query: string) => {
    setSearching(true)
    setSelectedGuest(null)
    setSelectedUid(null)
    try {
      const results = await searchGuests(query)
      setSearchResults(results)
    } catch (err) {
      console.error("Search failed:", err)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  const handleSelect = useCallback(async (uid: string) => {
    setSelectedUid(uid)
    setLoadingGuest(true)
    try {
      const record = await getGuestRecord(uid)
      setSelectedGuest(record)
    } catch (err) {
      console.error("Failed to load guest:", err)
      setSelectedGuest(null)
    } finally {
      setLoadingGuest(false)
    }
  }, [])

  // Auth guard
  if (!isAuthReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a12]">
        <p className="text-white/40 text-sm">Loading...</p>
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a12]">
        <Card className="bg-white/5 border-white/10 max-w-sm w-full">
          <CardContent className="pt-6 text-center">
            <p className="text-white/60 text-sm">Please sign in to access the admin portal.</p>
            <a href="/login" className="mt-4 inline-block text-indigo-400 underline text-sm">
              Go to Login
            </a>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a12] text-white">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0a0a12]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <img src="/omnam-logo-white.png" alt="Omnam" className="h-6 w-auto opacity-75" />
            <Separator orientation="vertical" className="h-5 bg-white/20" />
            <h1 className="text-sm font-semibold text-white/80">Back of House</h1>
          </div>
          <p className="text-xs text-white/30">{firebaseUser?.email}</p>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-7xl px-6 py-8 space-y-6">
        <SearchPanel
          results={searchResults}
          loading={searching}
          onSearch={handleSearch}
          onSelect={handleSelect}
          selectedUid={selectedUid}
        />

        {loadingGuest && (
          <div className="flex justify-center py-12">
            <p className="text-white/40 text-sm">Loading guest record...</p>
          </div>
        )}

        {selectedGuest && !loadingGuest && <GuestDetail guest={selectedGuest} />}

        {!selectedGuest && !loadingGuest && searchResults.length > 0 && (
          <div className="flex justify-center py-12">
            <p className="text-white/40 text-sm">Select a guest to view their full profile</p>
          </div>
        )}
      </main>
    </div>
  )
}
