// ---------------------------------------------------------------------------
// Multi-unit selection — PURE module. No React, no UE5 imports. Unit-tested.
//
// The frontend is the single source of truth for selection state. UE5 renders
// whatever `selectUnits` set we send and emits tap events; it holds no
// queue/capacity logic. Two distinct concepts (do NOT conflate):
//   • Selection set — the N highlighted units (multi). Per-room-type FIFO buckets,
//     each capped at that type's plan quantity.
//   • Focus / active unit — the ONE unit used for interior/exterior view (single).
//
// All three input sources (panel/plan edits, AI tools, UE5 taps) funnel through
// these reducer-grade pure functions, so the behaviour is identical regardless
// of where a selection change originates. See multi-unit-selection-plan.md §B0.
// ---------------------------------------------------------------------------

import { rooms as ALL_ROOMS } from "@/lib/hotel-data"

/** One physical unit reported by UE5. */
export interface UnitInventoryEntry {
  id: number
  roomTypeId: string   // catalog room id (r1…), normalized on ingest
  type: string         // raw UE5 type string (kept for debugging / fallback)
  level: number
  x: number; y: number; z: number
  price: number
  available: boolean
  name: string
  view?: string
}

/** Selection state: per-type FIFO queues (oldest first) + the single focused unit. */
export interface UnitSelectionState {
  buckets: Record<string, number[]>   // roomTypeId -> ordered unitIds
  activeUnitId: number | null
}

export const EMPTY_SELECTION: UnitSelectionState = { buckets: {}, activeUnitId: null }

/** roomTypeId -> capacity (from currentRoomPlan quantities). */
export type CapacityMap = Record<string, number>

// TODO(UE5 contract): fill once UE5 unit `type` strings are known. Only used as a
// fallback when an inventory entry lacks `roomTypeId`.
export const UNIT_TYPE_TO_ROOM_ID: Record<string, string> = {}

/** Map a raw UE5 unit `type` to a catalog room id. */
export function roomIdForUnitType(type: string): string | undefined {
  return UNIT_TYPE_TO_ROOM_ID[type]
}

/** Normalize raw UE5 inventory units into typed entries with a resolved roomTypeId.
 *  Drops entries whose roomTypeId can't be resolved to a real catalog room. */
export function normalizeInventory(raw: unknown): UnitInventoryEntry[] {
  if (!Array.isArray(raw)) return []
  const validRoomIds = new Set(ALL_ROOMS.map((r) => r.id))
  const out: UnitInventoryEntry[] = []
  for (const u of raw as Array<Record<string, unknown>>) {
    const id = Number(u.id)
    if (!Number.isFinite(id)) continue
    const type = String(u.type ?? "")
    const roomTypeId = String(u.roomTypeId ?? roomIdForUnitType(type) ?? "")
    if (!validRoomIds.has(roomTypeId)) continue   // unknown type → skip (defensive)
    out.push({
      id, roomTypeId, type,
      level: Number(u.level) || 0,
      x: Number(u.x) || 0, y: Number(u.y) || 0, z: Number(u.z) || 0,
      price: Number(u.price) || 0,
      available: u.available !== false,
      name: String(u.name ?? `Unit ${id}`),
      view: typeof u.view === "string" ? u.view : undefined,
    })
  }
  return out
}

export function inventoryById(inv: UnitInventoryEntry[]): Map<number, UnitInventoryEntry> {
  return new Map(inv.map((u) => [u.id, u]))
}

// ---------------------------------------------------------------------------
// Selection algebra — reducer-grade pure functions. Behavior spec is normative.
// ---------------------------------------------------------------------------

/** Flatten all bucket queues into the green selection set (stable order: by type, then queue order). */
export function selectedUnitIds(sel: UnitSelectionState): number[] {
  return Object.keys(sel.buckets).sort().flatMap((t) => sel.buckets[t])
}

/** Default auto-fill pick policy: available, not-already-queued units of `roomTypeId`,
 *  sorted by price asc then level asc. */
function pickUnits(
  roomTypeId: string, need: number, alreadyQueued: number[],
  inv: UnitInventoryEntry[],
): number[] {
  if (need <= 0) return []
  const taken = new Set(alreadyQueued)
  return inv
    .filter((u) => u.roomTypeId === roomTypeId && u.available && !taken.has(u.id))
    .sort((a, b) => a.price - b.price || a.level - b.level)
    .slice(0, need)
    .map((u) => u.id)
}

/** Reconcile buckets to the plan capacities:
 *  - type removed from plan (capacity 0/absent) → drop bucket
 *  - capacity↑ → auto-fill from available units (pickUnits)
 *  - capacity↓ → keep the most-recent `capacity` entries (drop from the FRONT)
 *  - fix activeUnitId if it's no longer selected. */
export function reconcileToPlan(
  sel: UnitSelectionState, capacities: CapacityMap, inv: UnitInventoryEntry[],
): UnitSelectionState {
  const buckets: Record<string, number[]> = {}
  for (const [roomTypeId, capRaw] of Object.entries(capacities)) {
    const cap = Math.max(0, Math.floor(capRaw))
    if (cap <= 0) continue
    let queue = (sel.buckets[roomTypeId] ?? []).slice()
    if (queue.length > cap) queue = queue.slice(queue.length - cap)   // keep most-recent
    if (queue.length < cap) queue = queue.concat(pickUnits(roomTypeId, cap - queue.length, queue, inv))
    buckets[roomTypeId] = queue
  }
  const all = new Set(Object.values(buckets).flat())
  const activeUnitId =
    sel.activeUnitId != null && all.has(sel.activeUnitId)
      ? sel.activeUnitId
      : (Object.keys(buckets).sort().flatMap((t) => buckets[t])[0] ?? null)
  return { buckets, activeUnitId }
}

/** UE5 tap (or AI pick) of ONE unit: focus it, and select it if new (FIFO-evict oldest of its
 *  type when the bucket is full). Never deselects. `capacity` is that type's plan quantity. */
export function tapUnit(
  sel: UnitSelectionState, unitId: number, roomTypeId: string, capacity: number,
): UnitSelectionState {
  const cap = Math.max(1, Math.floor(capacity))
  const buckets = { ...sel.buckets }
  let queue = (buckets[roomTypeId] ?? []).slice()
  if (!queue.includes(unitId)) {
    queue.push(unitId)
    if (queue.length > cap) queue = queue.slice(queue.length - cap)   // FIFO evict oldest of THIS type
  }
  buckets[roomTypeId] = queue
  return { buckets, activeUnitId: unitId }   // ALWAYS focus the tapped unit
}

/** Explicit deselection (panel trash / AI / dedicated gesture). Re-focuses a survivor. */
export function deselectUnit(
  sel: UnitSelectionState, unitId: number, roomTypeId: string,
): UnitSelectionState {
  const buckets = { ...sel.buckets }
  buckets[roomTypeId] = (buckets[roomTypeId] ?? []).filter((id) => id !== unitId)
  if (buckets[roomTypeId].length === 0) delete buckets[roomTypeId]
  const all = new Set(Object.values(buckets).flat())
  const activeUnitId =
    sel.activeUnitId === unitId
      ? (Object.keys(buckets).sort().flatMap((t) => buckets[t])[0] ?? null)
      : sel.activeUnitId
  return { buckets, activeUnitId }
}

/** Focus only — for view_unit({unitId}) / AI. Does not change selection. */
export function setActiveUnit(sel: UnitSelectionState, unitId: number): UnitSelectionState {
  return { ...sel, activeUnitId: unitId }
}

/** Totals: per plan entry, `quantity` priced slots; each slot uses the selected unit's real
 *  price, falling back to the catalog price for unfilled slots. Capacity stays catalog-derived. */
export function computeSelectionTotals(
  planEntries: Array<{ roomId: string; quantity: number }>,
  sel: UnitSelectionState, byId: Map<number, UnitInventoryEntry>,
): { totalPerNight: number; capacity: number } {
  let totalPerNight = 0, capacity = 0
  for (const { roomId, quantity } of planEntries) {
    const room = ALL_ROOMS.find((r) => r.id === roomId)
    if (!room) continue
    const catalogPrice = room.price
    const occ = parseInt(room.occupancy, 10) || 0
    const queue = sel.buckets[roomId] ?? []
    for (let i = 0; i < quantity; i++) {
      const unit = queue[i] != null ? byId.get(queue[i]) : undefined
      totalPerNight += unit?.price ?? catalogPrice
    }
    capacity += occ * quantity
  }
  return { totalPerNight, capacity }
}
