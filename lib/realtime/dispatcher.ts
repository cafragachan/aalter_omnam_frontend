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
import type { RealtimeSkillId } from "./skills"
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
  /** The currently focused unit id (selection.activeUnitId), or null when no unit
   *  is focused. A bare `view_unit interior` enters this unit — the auto-focus of a
   *  proposed plan counts, because the guest asking to go in IS the consent (the
   *  persona governs WHEN Ava calls the tool; the dispatcher only ensures there is
   *  actually a unit to enter). Returns null → there is nothing focused to step into. */
  getActiveUnit?: () => number | null
  /** Current room plan (for open_booking's default room when no id is given). */
  getPlan?: () => CurrentRoomPlan | null
  /** Begin the end-of-experience close (mute mic, speak farewell, then tear the
   *  session + UE5 stream down and show the send-off overlay). Only invoked after
   *  the guest has confirmed — see the end_experience confirm gate below. */
  onEndExperience?: () => void
  injectSkill?: (id: RealtimeSkillId, reason?: string, opts?: { respond?: boolean; force?: boolean }) => void
}

export function createToolDispatcher(ue5: Ue5Bridge, hooks: DispatcherHooks = {}) {
  const cat = getHotelCatalog(PILOT_HOTEL_SLUG)
  // First room of the latest proposed plan — open_booking defaults to it.
  let lastPlanFirstRoomId: string | null = null
  // The guest starts in the virtual lounge; hotel navigation is gated until they
  // travel (startTEST). Mirrors the journey's VIRTUAL_LOUNGE → hotel transition.
  let arrived = false
  const LOUNGE_GATE = "The guest is still in the virtual lounge — call travel_to_hotel first."

  // Just-in-time nudge for the OPTIONAL virtual-lounge gallery beat. The persona's
  // lounge invitation is one soft line buried among many "keep moving" rules, so
  // the model reliably skips it. Instead of trusting it to remember, we surface it
  // at the single moment it's meant to happen: the guest has shared the first
  // details (dates AND who's travelling) but is still in the lounge — right before
  // they'd be whisked to the hotel. Appended ONCE to save_profile's output so it
  // shapes that very turn's spoken reply. Still only an OFFER — a rushing guest is
  // taken straight to the hotel per the persona.
  let sawStayDates = false
  let sawTravelParty = false
  let loungeBeatNudged = false

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
  // The specific amenity a go_to_amenity walk-in is currently entering (its own
  // gameEstate:amenities + communal are scheduled). Lets a redundant
  // navigate_to(amenities) in the same model burst step aside instead of scheduling
  // a generic area-nav that could land after the walk-in and snap to the overview.
  let pendingAmenityId: string | null = null
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
        hooks.injectSkill?.("scene_navigation", "The guest is travelling from the lounge to the hotel.")
        hooks.injectSkill?.("lounge", "The guest is leaving or may leave the virtual lounge.")
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
        hooks.injectSkill?.("scene_navigation", "The guest asked to return to the lounge.")
        hooks.injectSkill?.("lounge", "The virtual lounge is active again.")
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
        hooks.injectSkill?.("ending", "The guest signalled they may want to end the experience.")
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

        // Track the two "first details" the lounge beat waits on.
        if (updates.startDate || updates.endDate) sawStayDates = true
        if (updates.guestComposition) sawTravelParty = true

        // Fire the lounge-gallery nudge ONCE, only while still in the lounge and
        // not already en route, the moment both first details are known.
        if (!arrived && !travelPending && !loungeBeatNudged && sawStayDates && sawTravelParty) {
          hooks.injectSkill?.("lounge", "The guest has shared first trip details while still in the virtual lounge.")
          loungeBeatNudged = true
          return `Remembered: ${summary}. The guest is still in the virtual lounge and you now know their dates and who's travelling — this is the natural moment, just before you'd travel, to offer ONE warm, unforced line inviting them to take in the lounge gallery first (a space that will one day host rotating exhibitions). Keep it a graceful, optional prelude, never a step to complete, and don't push it. If they'd rather head straight over, or seem to be moving quickly, simply call travel_to_hotel instead.`
        }

        return `Remembered: ${summary}.`
      }

      case "navigate_to": {
        hooks.injectSkill?.("scene_navigation", "The guest is moving to another area of the 3D experience.")
        const area = String(args.area ?? "")
        if (!["rooms", "amenities", "location", "default"].includes(area)) {
          return `"${area}" is not a valid area (use rooms, amenities, location, or default).`
        }
        // A specific-amenity walk-in (go_to_amenity) already enters the amenities area
        // itself; a redundant navigate_to(amenities) in the same burst would schedule a
        // generic gameEstate that can land AFTER the walk-in's communal and snap the
        // camera back to the overview. Defer to the in-flight walk-in.
        if (area === "amenities" && pendingAmenityId != null) {
          return here("Already taking the guest into the amenities space.")
        }
        // Send the actual UE5 scene change, gated behind the scene-settle window so
        // a just-departed travel (UE5 still loading) doesn't drop the command.
        const sendNav = () =>
          whenSceneReady(() => {
            switch (area) {
              case "rooms": ue5.navigateToRooms(); break
              case "amenities": ue5.navigateToAmenities(); break
              case "location": ue5.navigateToLocation(); break
              case "default": ue5.resetToDefault(); break
            }
            // Flip the PAGE scene label ONLY when UE5 actually navigates — this send
            // can be deferred a full travel-settle (~3.5s) after a just-departed
            // arrival. The page's selectUnits emit keys off this label (+ its own
            // rooms-settle), so flipping it early (before UE5 enters rooms) makes the
            // highlight fire into the OLD scene and then get wiped when the real nav
            // lands. Aligning the label with the actual send keeps the highlight
            // strictly AFTER the scene rebuild. (Matches revealRooms in propose_room_plan.)
            hooks.onScene?.(area)
          })
        // Commit the authoritative scene state + HUD. Leaving the rooms overview
        // drops any interior/exterior camera + unit focus — the guest is no longer
        // inside a unit, so a later "step back inside" must re-navigate first. The
        // dispatcher's own sceneArea stays SYNCHRONOUS (so propose_room_plan's
        // in-place guard sees "rooms" this same turn); only the page label is
        // deferred above. Runs AFTER sendNav so it doesn't shrink the travel-settle
        // window sendNav captured.
        const go = () => {
          // When THIS nav actually lands (whenSceneReady fires at the current
          // sceneReadyAt — possibly a full travel-settle out). Capture it before
          // sendNav so the next scene send is gated AFTER it, not off `now`.
          const navAt = Math.max(Date.now(), sceneReadyAt)
          sendNav()
          sceneArea = area as SceneArea
          sceneView = "overview"
          focusUnitId = null
          hooks.onRoomsPanel?.(area === "rooms")
          // Gate the NEXT scene-dependent send until AFTER this nav lands + settles.
          // Using `now` here would shrink the window below this still-pending nav, so
          // a second scene tool in the same burst would fire BEFORE it (out of order).
          sceneReadyAt = navAt + SCENE_SETTLE_MS
        }

        // Self-heal from the lounge: a rushed guest can ask for an amenity / the
        // surroundings before travelling. Take them to the hotel FIRST (same chain
        // as travel_to_hotel / propose_room_plan), then run the requested nav —
        // instead of bouncing a LOUNGE_GATE the model often forgets to retry.
        if (!arrived) {
          const where = area === "location" ? "the surrounding area" : area
          const status = ensureArrival(() => {
            go()
            hooks.notify?.(
              `[scene ready] You've arrived at the EDITION Lake Como and taken the guest to ${where}. Continue naturally from there.`,
            )
          })
          if (status === "pending") {
            return `Heading to the hotel now — it's still loading, so do NOT say you've arrived. The moment it's ready I'll take the guest to ${where}.`
          }
          // Arrived synchronously — fall through and navigate now.
        }

        go()
        if (area === "location") {
          return here("Now viewing the surrounding area. Call show_points_of_interest with a category (fine dining, landmarks, lakeside towns…) to map nearby places, then describe a couple.")
        }
        return here(`Navigated to ${area}.`)
      }

      case "show_points_of_interest": {
        hooks.injectSkill?.("scene_navigation", "The guest is exploring the surrounding area.")
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
        hooks.injectSkill?.("scene_navigation", "The guest is walking to a specific amenity.")
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
        // Walk into the amenity, gated behind the scene-settle so a just-departed
        // travel doesn't drop the command. Self-contained: enter the amenities AREA
        // first (gameEstate:amenities), let UE5 load it, THEN walk to the specific
        // space (communal) — UE5 needs the area scene before the space command, and
        // this guarantees that order regardless of what else the model fires.
        const walkIn = () => {
          const amenityId = match.id
          // Only (re)enter the area when coming from elsewhere — if already in the
          // amenities scene, a redundant gameEstate would reload it and snap back to
          // the overview before we walk in.
          const enterArea = sceneArea !== "amenities" && sceneArea !== "amenity"
          // Suppresses a redundant navigate_to(amenities) in this same model burst.
          pendingAmenityId = amenityId
          const navAt = Math.max(Date.now(), sceneReadyAt)
          whenSceneReady(async () => {
            if (enterArea) {
              ue5.navigateToAmenities()                                  // enter the area first
              await new Promise((r) => setTimeout(r, SCENE_SETTLE_MS))   // let UE5 load it
            }
            ue5.navigateToAmenity(amenityId)                             // then walk to the space
            hooks.onScene?.(match.name)                                 // label flips when nav lands
            pendingAmenityId = null
          })
          // Walking into an amenity leaves the rooms scene — clear interior/focus.
          sceneArea = "amenity"
          sceneView = "overview"
          focusUnitId = null
          // Next scene send waits until AFTER this lands + settles (see go()). When we
          // also entered the area first, that's two settle hops out.
          sceneReadyAt = navAt + (enterArea ? SCENE_SETTLE_MS * 2 : SCENE_SETTLE_MS)
        }

        // Self-heal from the lounge: travel first, then walk in — same chain as
        // propose_room_plan, so "I'm in a rush, show me the pool" actually lands in
        // the pool instead of stalling at the welcome.
        if (!arrived) {
          const status = ensureArrival(() => {
            walkIn()
            hooks.notify?.(
              `[scene ready] You've arrived at the EDITION Lake Como and walked the guest into ${match.name}. Continue naturally from there.`,
            )
          })
          if (status === "pending") {
            return `Heading to the hotel now — it's still loading, so do NOT say you've arrived. The moment it's ready I'll walk the guest into ${match.name}.`
          }
          // Arrived synchronously — fall through and walk in now.
        }

        walkIn()
        return here(`Walking the guest into ${match.name}.`)
      }

      case "view_unit": {
        hooks.injectSkill?.("unit_selection", "The guest is viewing or entering a physical unit.")
        if (!arrived) return LOUNGE_GATE
        const view = String(args.view ?? "")
        if (view !== "interior" && view !== "exterior") {
          return `view must be "interior" or "exterior".`
        }
        // Interior view needs a unit to step into. A bare `view_unit interior`
        // (no unitId) enters the currently FOCUSED unit — including a plan's
        // auto-focus: the guest asking to go in is the consent, and the persona
        // governs WHEN Ava calls this. We only block when there is genuinely
        // nothing focused to enter. (Undefined hook → don't block: safe default.)
        if (view === "interior" && typeof args.unitId !== "number") {
          const focused = hooks.getActiveUnit?.()
          if (focused == null && hooks.getActiveUnit) {
            return `No unit is focused yet — invite the guest to tap one of the available units (or tell me which one), then I'll step inside.`
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
        hooks.injectSkill?.("unit_selection", "The guest is choosing specific physical units.")
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
        hooks.injectSkill?.("room_recommendation", "Ava is recommending or changing a room plan.")
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
          // Already in the rooms experience (overview or inside a unit): do NOT
          // re-issue gameEstate:rooms. SET_ROOM_PLAN's selection reconcile already
          // re-highlights in place via the page emit effect; a redundant scene-nav
          // would rebuild the rooms level and drop the freshly-sent selectUnits
          // (and reset the orbit camera). Only navigate when coming from elsewhere
          // — the lounge/default after travel, an amenity, or the surroundings —
          // where the emit effect waits out ROOMS_SETTLE before highlighting.
          if (sceneArea === "rooms") return
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
              `[scene ready] You've arrived at the EDITION Lake Como and the recommended rooms (${summarizeRoomPlan(plan)}) are now marked in the scene. Welcome the guest warmly, say in a line why this fits, and invite them to step inside whenever they're ready (or tap a different unit to focus it).`,
            )
          })
          if (status === "pending") {
            return `Plan staged: ${summarizeRoomPlan(plan)} - $${plan.totalPerNight}/night, sleeps ${plan.capacity}. The 3D experience is still loading, so do NOT say it's ready — tell the guest you're bringing them in now and you'll show these rooms the moment it loads.`
          }
          // Arrived synchronously — fall through and reveal the rooms now.
        }

        revealRooms()
        return here(`Proposed plan: ${summarizeRoomPlan(plan)} - $${plan.totalPerNight}/night, sleeps ${plan.capacity}. The matching units are now marked in the scene (one is focused) - say in a line why it fits, then invite the guest to step inside whenever they're ready (or tap a different unit to focus it). When they say yes, call view_unit interior.`)
      }

      case "open_booking": {
        hooks.injectSkill?.("booking", "The guest is moving toward booking.")
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
