// Phase A.2 — tool dispatcher. Executes the model's function calls against the
// UE5 bridge, with a light validation guardrail, and returns a short string
// that becomes the function_call_output (so the model knows the result and can
// speak a natural ack). Runs client-side (needs the live useUE5Bridge instance).

import { getHotelCatalog } from "@/lib/hotel-data"
import type { useUE5Bridge } from "@/lib/ue5/bridge"
import type { SunState } from "@/components/SunToggle"
import type { UserProfile } from "@/lib/context"
import type { CurrentRoomPlan } from "@/lib/omnam-store"
import type { UnitInventoryEntry } from "@/lib/selection"
import {
  bookingRoomFromPlan,
  buildRoomPlan,
  parseProfileUpdates,
  summarizeProfile,
  summarizeRoomPlan,
  validatePlanCapacity,
  validateUnitSelection,
} from "@/lib/agent-runtime/tool-core"
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
  /** Whether the guest has spoken (a genuine user turn) SINCE the focused unit was
   *  last set. Presenting/selecting a unit is not permission to enter it — this
   *  gates bare interior entry so a select_units→interior (or tap→interior) chain
   *  can't whisk the guest inside in the same beat. The unitId-present path (the
   *  guest named a specific unit to enter) bypasses this. */
  hasUserSpokenSinceFocus?: () => boolean
  /** Current room plan (for open_booking's default room when no id is given). */
  getPlan?: () => CurrentRoomPlan | null
  /** Begin the end-of-experience close (mute mic, speak farewell, then tear the
   *  session + UE5 stream down and show the send-off overlay). Only invoked after
   *  the guest has confirmed — see the end_experience confirm gate below. */
  onEndExperience?: () => void
}

export function createToolDispatcher(ue5: Ue5Bridge, hooks: DispatcherHooks = {}) {
  const cat = getHotelCatalog(PILOT_HOTEL_SLUG)
  // First room of the latest proposed plan — open_booking defaults to it.
  let lastPlanFirstRoomId: string | null = null
  // The guest starts in the virtual lounge; hotel navigation is gated until they
  // travel (startTEST). Mirrors the journey's VIRTUAL_LOUNGE → hotel transition.
  let arrived = false
  const LOUNGE_GATE = "The guest is still in the virtual lounge — call travel_to_hotel first."

  // --- Authoritative scene state (the dispatcher's source of truth for where
  //     UE5 actually is). The model only "remembers" where it is from its own
  //     narration, which drifts; this is what we reconcile against so a stale
  //     belief can never strand us out of sync with UE5. Every nav tool updates
  //     it; leaving the rooms scene clears the interior/focus (the camera is no
  //     longer inside a unit), so a later "step back inside" knows it must
  //     re-navigate to rooms first instead of firing a no-op unitView. ---
  type SceneArea = "lounge" | "rooms" | "amenities" | "location" | "amenity" | "default"
  type SceneView = "overview" | "interior" | "exterior"
  let sceneArea: SceneArea = "lounge"
  let sceneView: SceneView = "overview"
  let focusUnitId: number | null = null
  // A compact, authoritative "you are here" appended to nav tool outputs so every
  // result re-grounds the model and drift can't accumulate. (Guidance for Ava —
  // not something to read aloud.)
  const sceneSummary = (): string => {
    if (!arrived) return "the virtual lounge"
    if (sceneArea === "rooms" && sceneView === "interior") return "inside the selected unit"
    if (sceneArea === "rooms" && sceneView === "exterior") return "the unit exterior"
    if (sceneArea === "rooms") return "the rooms overview"
    if (sceneArea === "amenities") return "the amenities overview"
    if (sceneArea === "amenity") return "an amenity space"
    if (sceneArea === "location") return "the surrounding area"
    return "the hotel grounds"
  }
  const here = (msg: string) => `${msg} (Scene now: ${sceneSummary()}.)`

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
  // When view_unit has to REBUILD the rooms scene first (the guest wandered off to
  // an amenity, then asked to step back inside), wait out the rooms re-entry +
  // re-highlight (ROOMS_SETTLE_MS in the page) + a unit re-frame before the camera
  // moves inside. Larger than FOCUS_BEFORE_VIEW_MS because the whole level reloads.
  const REENTER_ROOMS_VIEW_MS = 2500
  const whenSceneReady = (fn: () => void) => {
    const wait = sceneReadyAt - Date.now()
    if (wait <= 0) fn()
    else setTimeout(fn, wait)
  }

  // Actually depart the lounge for the property. Idempotent-safe: only the caller
  // gates on `arrived`. Sets the authoritative scene state to the post-travel
  // default view and arms the travel-settle window.
  const depart = () => {
    ue5.startTest() // emits { type: "startTEST", value: "startTEST" }
    arrived = true
    sceneArea = "default"
    sceneView = "overview"
    focusUnitId = null
    sceneReadyAt = Date.now() + TRAVEL_SETTLE_MS
    hooks.onArrived?.(true)
    hooks.onScene?.("traveling to the hotel")
  }

  // Ensure the guest is at the hotel. Returns "arrived" if we're there now
  // (departed synchronously, or already arrived), or "pending" if UE5 is still
  // loading — in which case it polls until ready and runs `onArrivedLater` once it
  // finally departs (or notifies an error on timeout). Shared by travel_to_hotel
  // and propose_room_plan's auto-travel so both follow the exact same chain.
  const ensureArrival = (onArrivedLater?: () => void): "arrived" | "pending" => {
    if (arrived) return "arrived"
    const ready = hooks.isUe5Ready?.() ?? true // no hook → don't block
    if (ready) {
      depart()
      return "arrived"
    }
    if (!travelPending) {
      travelPending = true
      hooks.onScene?.("loading the experience…")
      const startedAt = Date.now()
      const poll = () => {
        if (hooks.isUe5Ready?.()) {
          travelPending = false
          depart()
          onArrivedLater?.()
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
    return "pending"
  }

  return async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "travel_to_hotel": {
        const status = ensureArrival(() => {
          hooks.notify?.(
            "[scene ready] The 3D experience just finished loading and you've now arrived at the EDITION Lake Como. Welcome them warmly and briefly offer what they can explore — the rooms, the amenities, or the surrounding area — and let them choose. Don't recommend rooms unless they ask (or already asked).",
          )
        })
        if (status === "arrived") {
          return "Arriving at the EDITION Lake Como. Welcome them warmly to the property and briefly offer what they can explore — the rooms, the amenities, or the surrounding area — and let them choose. Don't recommend rooms unless they ask (or already asked); if they do want rooms, call propose_room_plan / navigate_to rooms (availability is preloaded)."
        }
        return "The 3D experience is still loading — do NOT say you've arrived. Tell the guest you're getting everything ready and you'll bring them in the moment it's set; you can keep chatting meanwhile."
      }

      case "return_to_lounge": {
        ue5.sendCommand("virtualLounge", "virtualLounge")
        arrived = false
        sceneArea = "lounge"
        sceneView = "overview"
        focusUnitId = null
        sceneReadyAt = Date.now() + TRAVEL_SETTLE_MS
        hooks.onRoomsPanel?.(false)
        hooks.onArrived?.(false)
        hooks.onScene?.("virtual lounge")
        return "Heading back to the virtual lounge."
      }

      case "end_experience": {
        // Two-step confirm gate — deterministic, never tears down on a single
        // call. The guest must explicitly confirm: only confirmed===true ends.
        // (If the guest declines, Ava simply never calls it again with true.)
        if (args.confirmed !== true) {
          return "Before ending, warmly ask the guest to confirm they'd like to end the experience now. Only call end_experience again with confirmed=true once they clearly say yes. If they're unsure or decline, stay with them and continue as normal."
        }
        hooks.onEndExperience?.()
        hooks.onScene?.("ending the experience")
        return "Give the guest a warm, brief farewell now — thank them and wish them well. This is your last message; right after it the experience will close."
      }

      case "save_profile": {
        const updates = parseProfileUpdates(args)
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
        // Leaving the rooms overview (or moving within the hotel) drops any
        // interior/exterior camera + unit focus — the guest is no longer inside a
        // unit, so a later "step back inside" must re-navigate to rooms first.
        sceneArea = area as SceneArea
        sceneView = "overview"
        focusUnitId = null
        hooks.onRoomsPanel?.(area === "rooms")
        hooks.onScene?.(area)
        sceneReadyAt = Date.now() + SCENE_SETTLE_MS
        if (area === "location") {
          return here("Now viewing the surrounding area. Call show_points_of_interest with a category (fine dining, landmarks, lakeside towns…) to map nearby places, then describe a couple.")
        }
        return here(`Navigated to ${area}.`)
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
        // Walking into an amenity leaves the rooms scene — clear interior/focus.
        sceneArea = "amenity"
        sceneView = "overview"
        focusUnitId = null
        sceneReadyAt = Date.now() + SCENE_SETTLE_MS
        hooks.onScene?.(match.name)
        return here(`Walking the guest into ${match.name}.`)
      }

      case "view_unit": {
        if (!arrived) return LOUNGE_GATE
        const view = String(args.view ?? "")
        if (view !== "interior" && view !== "exterior") {
          return `view must be "interior" or "exterior".`
        }
        // Interior view requires an EXPLICIT pick — a guest tap or a named unit
        // (unitId) — NOT the plan's auto-focus. Otherwise Ava could whisk the guest
        // into a room they never chose. (Checked before any nav so a bare interior
        // request with nothing picked still gives the right nudge.)
        if (view === "interior" && typeof args.unitId !== "number") {
          if (!hooks.hasExplicitPick?.()) {
            return `No unit picked yet — invite the guest to tap one of the available units (or tell me which one), then I'll step inside.`
          }
          // A unit is focused, but PRESENTING a unit is not permission to enter it.
          // Require a real guest turn since the focus was set, so a select_units →
          // interior chain (or tap → interior) can't whisk them inside in the same
          // beat. (The unitId path above bypasses this — that's an explicit "enter
          // THIS unit" request.) Undefined hook → don't block (safe default).
          if (hooks.hasUserSpokenSinceFocus?.() === false) {
            return `The unit is presented in the scene (orbit view) — do NOT step inside yet. Invite the guest to explore it and wait for them to say yes before calling view_unit interior. (If they name a specific unit to enter, pass its unitId.)`
          }
        }

        // The guest is the source of truth. If we've wandered out of the rooms
        // scene (an amenity, the surroundings, a lounge return), a bare unitView
        // would fire against the wrong level and silently no-op — the desync loop.
        // Self-heal: rebuild the rooms scene, re-apply the unit focus, wait out the
        // re-entry + re-highlight, THEN move the camera. A series of calls that
        // GUARANTEES we end up actually inside the unit, regardless of what the
        // model believed.
        const needsReentry = sceneArea !== "rooms"

        // Focus a named unit first (routes through the reducer → SET_ACTIVE_UNIT →
        // selectUnits emit). Record it so a re-entry can restore the same focus.
        if (typeof args.unitId === "number") {
          hooks.setActiveUnit?.(args.unitId)
          focusUnitId = args.unitId
        }

        const applyView = () => {
          ue5.viewUnit(view)
          sceneArea = "rooms"
          sceneView = view as SceneView
          hooks.onScene?.(view === "interior" ? "inside the unit" : "unit exterior")
        }

        if (needsReentry) {
          ue5.navigateToRooms()
          sceneArea = "rooms"
          sceneView = "overview"
          hooks.onScene?.("rooms") // re-triggers the page's selectUnits re-highlight
          await new Promise((r) => setTimeout(r, REENTER_ROOMS_VIEW_MS))
          applyView()
          return here(`Brought the guest back into the rooms and now showing the ${view}.`)
        }

        // Already in the rooms scene — only wait for a fresh focus to re-frame.
        if (typeof args.unitId === "number") {
          await new Promise((r) => setTimeout(r, FOCUS_BEFORE_VIEW_MS))
        }
        applyView()
        return here(`Now showing the ${view}.`)
      }

      case "select_units": {
        if (!arrived) return LOUNGE_GATE
        const selection = validateUnitSelection(args, hooks.getInventory?.() ?? [], hooks.getPlan?.() ?? null)
        if (!selection.ok) return selection.message
        hooks.selectUnits?.(selection.unitIds)       // store reconciles + the emit effect sends selectUnits to UE5
        return selection.message
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
        const plan = buildRoomPlan(args.rooms)
        if (!plan) return "None of those room ids exist. Pick from the catalog."
        // Deterministic capacity guardrail — never propose a plan too small.
        const capacityError = validatePlanCapacity(plan, hooks.getPartySize?.())
        if (capacityError) return capacityError
        hooks.setRoomPlan?.(plan)
        lastPlanFirstRoomId = plan.rooms[0].roomId

        // Reveal the plan in the scene + panel. Navigate to rooms once UE5 has
        // settled (e.g. after travel). Highlighting is owned by the single emit
        // effect in HomePageContentRealtime (it reconciles the plan → unit
        // selection and sends selectUnits / the type-level fallback), so we send no
        // manual selectRoom here.
        const revealRooms = () => {
          hooks.onRoomsPanel?.(true)
          whenSceneReady(() => {
            ue5.navigateToRooms()
            sceneArea = "rooms"
            sceneView = "overview"
            focusUnitId = null
            hooks.onScene?.("rooms")
          })
        }

        // NEVER surface the plan/panel while the guest is still in the lounge — the
        // panel would float over the lounge while UE5 drops the gameEstate command,
        // desyncing the panel from the 3D scene (and stranding `arrived = false`).
        // Self-heal: take them to the hotel FIRST, then reveal the rooms — the same
        // depart/settle chain as travel_to_hotel, so model + UE5 + panel converge.
        if (!arrived) {
          const status = ensureArrival(() => {
            revealRooms()
            hooks.notify?.(
              `[scene ready] You've arrived at the EDITION Lake Como and the recommended rooms (${summarizeRoomPlan(plan)}) are now marked in the scene. Welcome the guest warmly and invite them to tap a unit to step inside.`,
            )
          })
          if (status === "pending") {
            return `Plan staged: ${summarizeRoomPlan(plan)} - $${plan.totalPerNight}/night, sleeps ${plan.capacity}. The 3D experience is still loading, so do NOT say it's ready — tell the guest you're bringing them in now and you'll show these rooms the moment it loads.`
          }
          // Arrived synchronously — fall through and reveal the rooms now.
        }

        revealRooms()
        return here(`Proposed plan: ${summarizeRoomPlan(plan)} - $${plan.totalPerNight}/night, sleeps ${plan.capacity}. The matching units are now marked in the scene - invite the guest to tap one of the available units to step inside.`)
      }

      case "open_booking": {
        const room = bookingRoomFromPlan(args, hooks.getPlan?.() ?? null, lastPlanFirstRoomId)
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
