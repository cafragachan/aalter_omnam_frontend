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

function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function fmtAbsoluteTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return String(ts)
  }
}

function fmtRelative(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "+0:00"
  const totalSec = Math.floor(deltaMs / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `+${m}:${s.toString().padStart(2, "0")}`
}

function fmtDuration(startIso: string | undefined | null, endIso: string | undefined | null): string {
  if (!startIso || !endIso) return "—"
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// Bucket label: "Today" / "Yesterday" / "Mon, 7 Apr 2026"
function dayBucketLabel(iso: string | undefined | null): string {
  if (!iso) return "Unknown date"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "Unknown date"
  const today = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(today) - startOfDay(d)) / 86400000)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function dayBucketKey(iso: string | undefined | null): string {
  if (!iso) return "unknown"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "unknown"
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
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

  // Group by day, preserving sort order (newest first)
  const groups: { key: string; label: string; items: [string, import("@/lib/firebase/types").SessionPointer][] }[] = []
  for (const entry of entries) {
    const [, pointer] = entry
    const key = dayBucketKey(pointer.startedAt)
    const label = dayBucketLabel(pointer.startedAt)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(entry)
    else groups.push({ key, label, items: [entry] })
  }

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-white/90">
          Session History ({entries.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {groups.map((group) => (
          <div key={group.key} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="text-[11px] uppercase tracking-wider text-white/40">{group.label}</p>
              <span className="text-[11px] text-white/30">· {group.items.length}</span>
              <Separator className="flex-1 bg-white/10" />
            </div>
            <Accordion type="single" collapsible className="w-full">
              {group.items.map(([sessionId, pointer]) => (
                <AccordionItem key={sessionId} value={sessionId} className="border-white/10">
                  <AccordionTrigger className="text-white/80 hover:text-white hover:no-underline">
                    <div className="flex flex-1 items-center gap-3 text-sm">
                      <span
                        className="font-medium tabular-nums text-white/90"
                        title={fmtDateTime(pointer.startedAt)}
                      >
                        {fmtTime(pointer.startedAt)}
                      </span>
                      <span className="text-xs text-white/40 tabular-nums">
                        {fmtDuration(pointer.startedAt, pointer.endedAt)}
                      </span>
                      {pointer.hotel && (
                        <Badge variant="outline" className="border-white/20 text-white/60 text-xs">
                          {pointer.hotel}
                        </Badge>
                      )}
                      <Badge variant="outline" className="border-white/20 text-white/50 text-xs">
                        {pointer.journeyStage}
                      </Badge>
                      <span className={cn("ml-auto text-xs font-medium", outcomeColor(pointer.bookingOutcome))}>
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
          </div>
        ))}
        {groups.length === 0 && (
          <p className="text-sm text-white/40">No sessions recorded yet.</p>
        )}
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

function Section({
  title,
  subtitle,
  children,
  empty,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  empty?: boolean
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <p className="text-[11px] uppercase tracking-wider text-white/50">{title}</p>
        {subtitle && <span className="text-[11px] text-white/30">· {subtitle}</span>}
      </div>
      {empty ? (
        <p className="text-xs text-white/30">None recorded</p>
      ) : (
        children
      )}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-white/40">{label}</p>
      <p className="text-sm text-white/90">{value}</p>
    </div>
  )
}

function SessionOverview({ snapshot }: { snapshot: SessionSnapshot }) {
  const gi = snapshot.guestIntelligence
  const messages = snapshot.conversationMessages ?? []
  const upsell = gi?.upsellReceptivity

  return (
    <Section title="Overview">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric
          label="Started"
          value={
            <span title={fmtDateTime(snapshot.startedAt)} className="tabular-nums">
              {fmtTime(snapshot.startedAt)}
            </span>
          }
        />
        <Metric label="Duration" value={fmtDuration(snapshot.startedAt, snapshot.endedAt)} />
        <Metric label="Hotel" value={snapshot.hotel ?? "—"} />
        <Metric label="Final Stage" value={snapshot.journeyStage ?? "—"} />
        <Metric
          label="Outcome"
          value={
            <span className={cn("font-medium", outcomeColor(gi?.bookingOutcome ?? ""))}>
              {gi?.bookingOutcome ?? "—"}
            </span>
          }
        />
        <Metric label="Messages" value={messages.length} />
        <Metric label="Travel Driver" value={gi?.travelDriver ?? "—"} />
        <Metric
          label="Upsell Receptivity"
          value={
            upsell != null ? (
              <div className="flex items-center gap-2">
                <Progress value={upsell * 100} className="h-1.5 flex-1 bg-white/10" />
                <span className="text-xs text-white/70 tabular-nums">
                  {Math.round(upsell * 100)}%
                </span>
              </div>
            ) : (
              "—"
            )
          }
        />
      </div>

      {gi?.personalityTraits && gi.personalityTraits.length > 0 && (
        <div className="pt-2 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Personality</p>
          <TagList items={gi.personalityTraits} />
        </div>
      )}

      <div className="flex items-center gap-2 pt-1 text-[10px] text-white/30">
        <span>sessionId</span>
        <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/50">
          {snapshot.sessionId}
        </code>
      </div>
    </Section>
  )
}

function ProfileBlock({ profile }: { profile: SessionSnapshot["profile"] }) {
  const gc = profile.guestComposition
  const composition = gc
    ? `${gc.adults} adult${gc.adults !== 1 ? "s" : ""}${gc.children > 0 ? `, ${gc.children} child${gc.children !== 1 ? "ren" : ""}` : ""}`
    : null

  return (
    <Section title="Profile Captured">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
        <Field label="First Name" value={profile.firstName} />
        <Field label="Last Name" value={profile.lastName} />
        <Field label="Email" value={profile.email} />
        <Field label="Phone" value={profile.phoneNumber} />
        <Field label="Date of Birth" value={fmtDate(profile.dateOfBirth)} />
        <Field label="Nationality" value={profile.nationality} />
        <Field label="Language" value={profile.languagePreference} />
        <Field label="Destination" value={profile.destination} />
        <Field label="Travel Purpose" value={profile.travelPurpose} />
        <Field label="Budget" value={profile.budgetRange} />
        <Field label="Start Date" value={fmtDate(profile.startDate)} />
        <Field label="End Date" value={fmtDate(profile.endDate)} />
        <Field label="Guest Composition" value={composition} />
        <Field label="Family Size" value={profile.familySize} />
        <Field label="Room Preference" value={profile.roomTypePreference} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Interests</p>
          <TagList items={profile.interests} />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Amenity Priorities</p>
          <TagList items={profile.amenityPriorities} />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Dietary Restrictions</p>
          <TagList items={profile.dietaryRestrictions} />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Accessibility Needs</p>
          <TagList items={profile.accessibilityNeeds} />
        </div>
      </div>
    </Section>
  )
}

function IntelligenceBlock({ gi }: { gi: SessionSnapshot["guestIntelligence"] }) {
  const hasQuestions = gi.topQuestions && gi.topQuestions.length > 0
  const hasRequirements = gi.requirements && gi.requirements.length > 0
  const hasObjections = gi.objections && gi.objections.length > 0
  const consent = gi.consentFlags

  return (
    <Section title="Guest Intelligence">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Top Questions</p>
          {hasQuestions ? (
            <ol className="list-decimal space-y-1 pl-4 text-xs text-white/75">
              {gi.topQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-white/30">None</p>
          )}
        </div>
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Requirements</p>
          {hasRequirements ? <TagList items={gi.requirements} /> : <p className="text-xs text-white/30">None</p>}
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <p className="text-[10px] uppercase tracking-wider text-white/40">Objections</p>
          {hasObjections ? (
            <div className="flex flex-wrap gap-1.5">
              {gi.objections.map((o, i) => (
                <Badge
                  key={`${o.topic}-${i}`}
                  variant="outline"
                  className={cn(
                    "text-xs",
                    o.resolved
                      ? "border-emerald-500/30 text-emerald-400"
                      : "border-amber-500/30 text-amber-400",
                  )}
                  title={o.resolution || undefined}
                >
                  {o.topic} · {o.resolved ? "resolved" : "unresolved"}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-white/30">None raised</p>
          )}
        </div>
        {consent && (
          <div className="md:col-span-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Consent Flags</p>
            <div className="flex flex-wrap gap-2">
              {[
                { label: "Marketing", value: consent.marketing },
                { label: "Data Sharing", value: consent.dataSharing },
                { label: "Analytics", value: consent.analytics },
                { label: "Third Party", value: consent.thirdParty },
              ].map((f) => (
                <div
                  key={f.label}
                  className={cn(
                    "flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px]",
                    f.value
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "border-white/10 bg-white/5 text-white/40",
                  )}
                >
                  <span>{f.value ? "\u2713" : "\u2717"}</span>
                  <span>{f.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  )
}

function ExplorationBlock({ gi }: { gi: SessionSnapshot["guestIntelligence"] }) {
  const rooms = gi.roomsExplored ?? []
  const amenities = gi.amenitiesExplored ?? []
  const empty = rooms.length === 0 && amenities.length === 0

  return (
    <Section title="Exploration" empty={empty}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            Rooms ({rooms.length})
          </p>
          {rooms.length > 0 ? (
            <div className="space-y-1">
              {rooms.map((r, i) => (
                <div
                  key={`${r.roomId}-${i}`}
                  className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs"
                >
                  <span className="text-white/80">{r.roomId}</span>
                  <span className="text-white/40 tabular-nums">
                    {(r.timeSpentMs / 1000).toFixed(0)}s
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-white/30">None</p>
          )}
        </div>
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            Amenities ({amenities.length})
          </p>
          {amenities.length > 0 ? (
            <div className="space-y-1">
              {amenities.map((a, i) => (
                <div
                  key={`${a.name}-${i}`}
                  className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs"
                >
                  <span className="text-white/80">{a.name}</span>
                  <span className="text-white/40 tabular-nums">
                    {(a.timeSpentMs / 1000).toFixed(0)}s
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-white/30">None</p>
          )}
        </div>
      </div>
    </Section>
  )
}

function ConversationTranscript({
  messages,
  startedAt,
}: {
  messages: SessionSnapshot["conversationMessages"]
  startedAt: string
}) {
  const list = messages ?? []
  const startMs = new Date(startedAt).getTime()
  const anchorMs = list.length > 0 ? Math.min(list[0].timestamp, startMs || list[0].timestamp) : startMs

  const copyTranscript = useCallback(() => {
    const text = list
      .map((m) => {
        const who = m.sender === "user" || m.sender === "USER" ? "Guest" : "Ava"
        return `[${fmtAbsoluteTimestamp(m.timestamp)}] ${who}: ${m.message}`
      })
      .join("\n")
    navigator.clipboard?.writeText(text).catch(() => {})
  }, [list])

  return (
    <Section
      title="Conversation Transcript"
      subtitle={`${list.length} message${list.length !== 1 ? "s" : ""}`}
      empty={list.length === 0}
    >
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={copyTranscript}
          className="h-7 border-white/20 text-[11px] text-white/60"
        >
          Copy transcript
        </Button>
      </div>
      <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
        {list.map((msg, i) => {
          const isUser = msg.sender === "USER" || msg.sender === "user"
          const rel = fmtRelative(msg.timestamp - anchorMs)
          const abs = fmtAbsoluteTimestamp(msg.timestamp)
          return (
            <div key={i} className={cn("flex", isUser ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[75%] rounded-2xl px-3 py-2 text-xs leading-relaxed",
                  isUser
                    ? "bg-indigo-500/20 text-indigo-200 rounded-br-sm"
                    : "bg-white/10 text-white/80 rounded-bl-sm",
                )}
              >
                <p className="mb-0.5 flex items-center gap-2 text-[10px] font-medium opacity-60">
                  <span>{isUser ? "Guest" : "Ava"}</span>
                  <span className="tabular-nums opacity-70" title={abs}>
                    {rel}
                  </span>
                </p>
                {msg.message}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function RawSnapshotBlock({ snapshot }: { snapshot: SessionSnapshot }) {
  return (
    <details className="group rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <summary className="cursor-pointer select-none text-[11px] uppercase tracking-wider text-white/40 hover:text-white/70">
        View raw snapshot (JSON)
      </summary>
      <pre className="mt-2 max-h-96 overflow-auto rounded bg-black/40 p-3 text-[11px] leading-relaxed text-white/70">
        {JSON.stringify(snapshot, null, 2)}
      </pre>
    </details>
  )
}

function SessionDetail({ snapshot }: { snapshot: SessionSnapshot }) {
  return (
    <div className="space-y-5 py-3">
      <SessionOverview snapshot={snapshot} />
      <Separator className="bg-white/10" />
      <ProfileBlock profile={snapshot.profile} />
      <Separator className="bg-white/10" />
      <IntelligenceBlock gi={snapshot.guestIntelligence} />
      <Separator className="bg-white/10" />
      <ExplorationBlock gi={snapshot.guestIntelligence} />
      <Separator className="bg-white/10" />
      <ConversationTranscript
        messages={snapshot.conversationMessages}
        startedAt={snapshot.startedAt}
      />
      <RawSnapshotBlock snapshot={snapshot} />
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
            <h1 className="text-sm font-semibold text-white/80">Admin Portal</h1>
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
