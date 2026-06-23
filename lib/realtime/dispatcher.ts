// Phase A.2 — tool dispatcher. Executes the model's function calls against the
// UE5 bridge, with a light validation guardrail, and returns a short string
// that becomes the function_call_output (so the model knows the result and can
// speak a natural ack). Runs client-side (needs the live useUE5Bridge instance).

import { getHotelCatalog } from "@/lib/hotel-data"
import type { useUE5Bridge } from "@/lib/ue5/bridge"
import type { SunState } from "@/components/SunToggle"
import type { UserProfile, GuestComposition } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import type { UnitInventoryEntry } from "@/lib/selection"
import { PILOT_HOTEL_SLUG } from "./context"

type Ue5Bridge = ReturnType<typeof useUE5Bridge>

export interface DispatcherHooks {
  /** HUD-only: report the new scene label (does NOT inject into the LLM — the
   *  function_call_output already keeps the model aware). */
  onScene?: (label: string) => void
  /** Persist a learned profile detail to the OmnamStore (UPDATE_PROFILE). */
  saveProfile?: (updates: Partial<UserProfile>) => void
  /** Write a recommended room plan to the OmnamStore (SET_ROOM_PLAN). */
  setRoomPlan?: (plan: CurrentRoomPlan) => void
  /** Show/hide the rooms panel. */
  onRoomsPanel?: (show: boolean) => void
  /** Whether the guest has travelled to the hotel (true) or is in the lounge
   *  (false). Drives hotel-only HUD like the lighting toggle. */
  onArrived?: (arrived: boolean) => void
  /** Current party size (adults + children), for the capacity guardrail. */
  getPartySize?: () => number | undefined
  /** Whether UE5 has finished loading (first stream message received). Gates
   *  travel_to_hotel so Ava never "arrives" before the 3D scene exists. */
  isUe5Ready?: () => boolean
  /** Proactively speak to the guest outside a tool call — used to tell them the
   *  scene finished loading after a gated travel. Wired to session.injectContext. */
  notify?: (text: string) => void
  /** Current physical-unit inventory (for validating AI unit picks). */
  getInventory?: () => UnitInventoryEntry[]
  /** AI multi-pick of physical units (dispatch AI_SELECT_UNITS). */
  selectUnits?: (unitIds: number[]) => void
  /** Focus a single unit for interior/exterior view (dispatch SET_ACTIVE_UNIT). */
  setActiveUnit?: (unitId: number) => void
  /** Whether the guest has EXPLICITLY picked a unit this plan (a real tap, or Ava
   *  naming one) — as opposed to the plan's auto-focus. Gates interior view so Ava
   *  can't step into a room the guest never chose. */
  hasExplicitPick?: () => boolean
  /** Current room plan (for open_booking's default room when no id is given). */
  getPlan?: () => CurrentRoomPlan | null
}

export function createToolDispatcher(ue5: Ue5Bridge, hooks: DispatcherHooks = {}) {
  const cat = getHotelCatalog(PILOT_HOTEL_SLUG)
  // First room of the latest proposed plan — open_booking defaults to it.
  let lastPlanFirstRoomId: string | null = null
  // The guest starts in the virtual lounge; hotel navigation is gated until they
  // travel (startTEST). Mirrors the journey's VIRTUAL_LOUNGE → hotel transition.
  let arrived = false
  const LOUNGE_GATE = "The guest is still in the virtual lounge — call travel_to_hotel first."

  // UE5 drops commands sent while a scene is still loading — especially the
  // ~3.5s server-travel after startTEST (mirrors the old UE5_POST_TRAVEL_DELAY_MS).
  // Gate scene-dependent sends (room highlight, POI markers) behind a "ready" time.
  const TRAVEL_SETTLE_MS = 3500
  const SCENE_SETTLE_MS = 1200
  let sceneReadyAt = 0

  // UE5 may still be loading when Ava (which starts independently) is already
  // chatting. Gate travel on the stream-ready signal: if the guest asks to
  // travel before UE5 is up, hold the startTEST and poll until it's ready, then
  // fire it and tell Ava she's arrived — so she never narrates a hotel that
  // doesn't exist yet. (Mirrors the old /home ue5Ready gate, but lets the lounge
  // intake overlap the UE5 load instead of blocking on it.)
  const UE5_READY_POLL_MS = 400
  const UE5_READY_TIMEOUT_MS = 30000
  let travelPending = false

  // When the guest moves from one unit's interior to ANOTHER unit, UE5 needs the
  // new focus (selectUnits) to land and re-frame before we switch the camera
  // inside, or the interior view targets the old unit / gets canceled. Give it ~1s.
  const FOCUS_BEFORE_VIEW_MS = 1000
  const whenSceneReady = (fn: () => void) => {
    const wait = sceneReadyAt - Date.now()
    if (wait <= 0) fn()
    else setTimeout(fn, wait)
  }

  return async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "travel_to_hotel": {
        // Actually depart — only ever called once UE5 is confirmed ready.
        const depart = () => {
          ue5.startTest() // emits { type: "startTEST", value: "startTEST" }
          arrived = true
          sceneReadyAt = Date.now() + TRAVEL_SETTLE_MS
          hooks.onArrived?.(true)
          hooks.onScene?.("traveling to the hotel")
        }

        const ready = hooks.isUe5Ready?.() ?? true // no hook → don't block
        if (ready) {
          depart()
          return "Arriving at the EDITION Lake Como. Welcome them warmly to the property and briefly offer what they can explore — the rooms, the amenities, or the surrounding area — and let them choose. Don't recommend rooms unless they ask (or already asked); if they do want rooms, call propose_room_plan / navigate_to rooms (availability is preloaded)."
        }

        // UE5 not loaded yet — hold the travel and poll until it is.
        if (!travelPending) {
          travelPending = true
          hooks.onScene?.("loading the experience…")
          const startedAt = Date.now()
          const poll = () => {
            if (hooks.isUe5Ready?.()) {
              travelPending = false
              depart()
              hooks.notify?.(
                "[scene ready] The 3D experience just finished loading and you've now arrived at the EDITION Lake Como. Welcome them warmly and briefly offer what they can explore — the rooms, the amenities, or the surrounding area — and let them choose. Don't recommend rooms unless they ask (or already asked).",
              )
              return
            }
            if (Date.now() - startedAt > UE5_READY_TIMEOUT_MS) {
              travelPending = false
              hooks.notify?.(
                "[scene error] The 3D experience is taking unusually long to load. Apologize briefly to the guest and offer to try again in a moment.",
              )
              return
            }
            setTimeout(poll, UE5_READY_POLL_MS)
          }
          setTimeout(poll, UE5_READY_POLL_MS)
        }
        return "The 3D experience is still loading — do NOT say you've arrived. Tell the guest you're getting everything ready and you'll bring them in the moment it's set; you can keep chatting meanwhile."
      }

      case "return_to_lounge": {
        ue5.sendCommand("virtualLounge", "virtualLounge")
        arrived = false
        sceneReadyAt = Date.now() + TRAVEL_SETTLE_MS
        hooks.onRoomsPanel?.(false)
        hooks.onArrived?.(false)
        hooks.onScene?.("virtual lounge")
        return "Heading back to the virtual lounge."
      }

      case "save_profile": {
        const updates: Partial<UserProfile> = {}
        if (typeof args.firstName === "string" && args.firstName.trim()) {
          updates.firstName = args.firstName.trim()
        }
        const gc: Partial<GuestComposition> = {}
        if (Number.isFinite(Number(args.adults))) gc.adults = Number(args.adults)
        if (Number.isFinite(Number(args.children))) gc.children = Number(args.children)
        if (Array.isArray(args.childrenAges)) {
          gc.childrenAges = (args.childrenAges as unknown[]).map(Number).filter(Number.isFinite)
        }
        if (Object.keys(gc).length) updates.guestComposition = gc as GuestComposition
        const start = parseDate(args.startDate)
        if (start) updates.startDate = start
        const end = parseDate(args.endDate)
        if (end) updates.endDate = end
        if (Array.isArray(args.interests)) updates.interests = (args.interests as unknown[]).map(String)
        if (typeof args.travelPurpose === "string") updates.travelPurpose = args.travelPurpose
        if (typeof args.budgetRange === "string") updates.budgetRange = args.budgetRange
        if (Array.isArray(args.dietaryRestrictions)) {
          updates.dietaryRestrictions = (args.dietaryRestrictions as unknown[]).map(String)
        }
        if (Array.isArray(args.accessibilityNeeds)) {
          updates.accessibilityNeeds = (args.accessibilityNeeds as unknown[]).map(String)
        }
        if (Object.keys(updates).length === 0) return "Nothing new to remember."
        hooks.saveProfile?.(updates)
        const summary = summarizeProfile(updates)
        hooks.onScene?.(`noted: ${summary}`)
        return `Remembered: ${summary}.`
      }

      case "navigate_to": {
        if (!arrived) return LOUNGE_GATE
        const area = String(args.area ?? "")
        switch (area) {
          case "rooms":
            ue5.navigateToRooms()
            break
          case "amenities":
            ue5.navigateToAmenities()
            break
          case "location":
            ue5.navigateToLocation()
            break
          case "default":
            ue5.resetToDefault()
            break
          default:
            return `"${area}" is not a valid area (use rooms, amenities, location, or default).`
        }
        hooks.onRoomsPanel?.(area === "rooms")
        hooks.onScene?.(area)
        sceneReadyAt = Date.now() + SCENE_SETTLE_MS
        if (area === "location") {
          return "Now viewing the surrounding area. Call show_points_of_interest with a category (fine dining, landmarks, lakeside towns…) to map nearby places, then describe a couple."
        }
        return `Navigated to ${area}.`
      }

      case "show_points_of_interest": {
        const category = String(args.category ?? "").trim()
        if (!category) return "Tell me what kind of places to show (e.g. fine dining, landmarks)."
        try {
          const res = await fetch("/api/locate-interest-points", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category, maxResults: 10 }),
          })
          if (!res.ok) return `Couldn't fetch nearby ${category} right now.`
          const data = (await res.json()) as { points?: Array<{ name?: string }> }
          const points = Array.isArray(data.points) ? data.points : []
          console.log("[POI] /api/locate-interest-points returned", points.length, "points for", category)
          // osm_data — array of places by name+type; gate until the location scene is loaded.
          whenSceneReady(() => ue5.sendOSMData(JSON.stringify({ points })))
          hooks.onScene?.(`points of interest: ${category}`)
          if (!points.length) return `I couldn't find notable ${category} nearby to map right now.`
          const names = points.slice(0, 5).map((p) => p.name).filter(Boolean).join(", ")
          return `Dropped ${points.length} ${category} markers on the map (${names}). Mention a couple to the guest.`
        } catch {
          return `Couldn't load nearby ${category} right now.`
        }
      }

      case "go_to_amenity": {
        if (!arrived) return LOUNGE_GATE
        const wanted = String(args.amenity ?? "").trim().toLowerCase()
        const match = cat?.amenities.find(
          (a) =>
            a.name.toLowerCase() === wanted ||
            a.aliases?.some((x) => x.toLowerCase() === wanted),
        )
        if (!match) {
          const describedOnly = cat?.amenitiesDescribedOnly.find(
            (a) => a.name.toLowerCase() === wanted,
          )
          if (describedOnly) {
            return `${describedOnly.name} is not part of the walkable tour yet — describe it for the guest instead of navigating.`
          }
          return `"${args.amenity}" is not a visitable amenity.`
        }
        ue5.navigateToAmenity(match.id)
        sceneReadyAt = Date.now() + SCENE_SETTLE_MS
        hooks.onScene?.(match.name)
        return `Walking the guest into ${match.name}.`
      }

      case "view_unit": {
        if (!arrived) return LOUNGE_GATE
        const view = String(args.view ?? "")
        if (view !== "interior" && view !== "exterior") {
          return `view must be "interior" or "exterior".`
        }
        // Focus a named unit first (routes through the reducer → SET_ACTIVE_UNIT →
        // selectUnits emit), then wait for UE5 to re-frame that focus BEFORE we
        // switch the camera inside — so moving between units' interiors targets the
        // newly requested unit instead of the one we were already in.
        if (typeof args.unitId === "number") {
          hooks.setActiveUnit?.(args.unitId)
          await new Promise((r) => setTimeout(r, FOCUS_BEFORE_VIEW_MS))
        }
        // Interior view requires an EXPLICIT pick — a guest tap or a named unit
        // (unitId, handled above) — NOT the plan's auto-focus. Otherwise Ava could
        // whisk the guest into a room they never chose.
        if (view === "interior" && typeof args.unitId !== "number" && !hooks.hasExplicitPick?.()) {
          return `No unit picked yet — invite the guest to tap one of the available units (or tell me which one), then I'll step inside.`
        }
        ue5.viewUnit(view)
        hooks.onScene?.(view === "interior" ? "inside the unit" : "unit exterior")
        return `Now showing the ${view}.`
      }

      case "select_units": {
        if (!arrived) return LOUNGE_GATE
        const ids = Array.isArray(args.unitIds) ? args.unitIds.map(Number).filter(Number.isFinite) : []
        const inv = hooks.getInventory?.() ?? []
        const avail = ids.filter((id) => inv.some((u) => u.id === id && u.available))
        if (!avail.length) return "None of those unit ids are available — pick available ids from the inventory."
        // Only units whose room TYPE is already in the plan can be highlighted —
        // mirrors the store (it ignores off-plan types). Adding a type is a
        // propose_room_plan job, so guide the model there instead of silently no-op.
        const planTypes = new Set((hooks.getPlan?.()?.rooms ?? []).map((r) => r.roomId))
        const inPlan = avail.filter((id) => {
          const u = inv.find((x) => x.id === id)
          return !!u && planTypes.has(u.roomTypeId)
        })
        if (!inPlan.length) {
          return "Those units aren't part of the current plan's room types — call propose_room_plan to add that room type first, then highlight the unit."
        }
        hooks.selectUnits?.(inPlan)       // store reconciles + the emit effect sends selectUnits to UE5
        const names = inPlan.map((id) => inv.find((u) => u.id === id)?.name ?? id).join(", ")
        const skipped = avail.length - inPlan.length
        return `Highlighted ${names}.` +
          (skipped ? ` (${skipped} unit(s) not in the current plan's room types were skipped — add them with propose_room_plan.)` : "")
      }

      case "set_lighting": {
        const mode = String(args.mode ?? "")
        if (mode !== "daylight" && mode !== "sunset" && mode !== "night") {
          return `mode must be daylight, sunset, or night.`
        }
        ue5.changeSunPosition(mode as SunState)
        hooks.onScene?.(`lighting: ${mode}`)
        return `Lighting set to ${mode}.`
      }

      case "propose_room_plan": {
        const raw = Array.isArray(args.rooms) ? (args.rooms as Array<Record<string, unknown>>) : []
        const planRooms: { roomId: string; quantity: number }[] = []
        let totalPerNight = 0
        let capacity = 0
        for (const r of raw) {
          const id = String(r.roomId ?? "")
          const qty = Math.max(1, Math.floor(Number(r.quantity ?? 1)) || 1)
          const room = cat?.rooms.find((x) => x.id === id)
          if (!room) continue
          planRooms.push({ roomId: id, quantity: qty })
          totalPerNight += room.price * qty
          capacity += room.occupancy * qty
        }
        if (!planRooms.length) return "None of those room ids exist — pick from the catalog."
        // Deterministic capacity guardrail — never propose a plan too small.
        const party = hooks.getPartySize?.()
        if (party && capacity < party) {
          return `That plan only sleeps ${capacity}, but the party is ${party}. Add a room or pick larger ones so everyone fits, then propose again.`
        }
        hooks.setRoomPlan?.({ rooms: planRooms, totalPerNight, capacity, source: "planner" })
        hooks.onRoomsPanel?.(true)
        lastPlanFirstRoomId = planRooms[0].roomId
        // Navigate to the rooms scene once UE5 has settled (e.g. after travel).
        // Highlighting is now owned by the single emit effect in
        // HomePageContentRealtime (it reconciles the plan → unit selection and
        // sends selectUnits / the type-level fallback), so we no longer send a
        // manual selectRoom here.
        whenSceneReady(() => {
          ue5.navigateToRooms()
          hooks.onScene?.("rooms")
        })
        const names = planRooms
          .map((p) => `${p.quantity}× ${cat?.rooms.find((x) => x.id === p.roomId)?.name ?? p.roomId}`)
          .join(", ")
        return `Proposed plan: ${names} — $${totalPerNight}/night, sleeps ${capacity}. The matching units are now marked in the scene — invite the guest to tap one of the available units to step inside.`
      }

      case "open_booking": {
        const id =
          String(args.roomId ?? "") ||
          lastPlanFirstRoomId ||
          hooks.getPlan?.()?.rooms[0]?.roomId ||
          ""
        const room = cat?.rooms.find((r) => r.id === id)
        if (!room) return "I'm not sure which room to book — let's settle on one first."
        if (!room.book_url) return `${room.name} doesn't have a booking link yet.`
        if (typeof window !== "undefined") window.open(room.book_url, "_blank", "noopener,noreferrer")
        return `Opening the booking page for ${room.name} in a new tab.`
      }

      default:
        return `Unknown tool "${name}".`
    }
  }
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function summarizeProfile(u: Partial<UserProfile>): string {
  const bits: string[] = []
  if (u.firstName) bits.push(u.firstName)
  if (u.guestComposition) {
    const { adults, children } = u.guestComposition
    const parts: string[] = []
    if (typeof adults === "number") parts.push(`${adults} adult${adults === 1 ? "" : "s"}`)
    if (typeof children === "number" && children > 0) parts.push(`${children} child${children === 1 ? "" : "ren"}`)
    if (parts.length) bits.push(parts.join(" + "))
  }
  if (u.startDate) bits.push(`from ${u.startDate.toISOString().slice(0, 10)}${u.endDate ? ` to ${u.endDate.toISOString().slice(0, 10)}` : ""}`)
  if (u.interests?.length) bits.push(u.interests.join(", "))
  if (u.travelPurpose) bits.push(u.travelPurpose)
  if (u.budgetRange) bits.push(u.budgetRange)
  if (u.dietaryRestrictions?.length) bits.push(`dietary: ${u.dietaryRestrictions.join(", ")}`)
  if (u.accessibilityNeeds?.length) bits.push(`access: ${u.accessibilityNeeds.join(", ")}`)
  return bits.join("; ") || "a detail"
}
