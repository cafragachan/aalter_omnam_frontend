import { describe, it, expect } from "vitest"
import {
  normalizeInventory,
  reconcileToPlan,
  tapUnit,
  deselectUnit,
  computeSelectionTotals,
  selectedUnitIds,
  inventoryById,
  UNIT_TYPE_TO_ROOM_ID,
  EMPTY_SELECTION,
  type UnitInventoryEntry,
  type UnitSelectionState,
} from "@/lib/selection"

// Catalog room ids used in these tests (from lib/hotels/lake-como.ts):
//   r1 = price 249, occupancy 2
//   r2 = price 599, occupancy 6
//   r3 = price 399, occupancy 4

/** Tiny builder for inventory entries — only the fields the algebra reads. */
function unit(
  id: number, roomTypeId: string,
  opts: Partial<UnitInventoryEntry> = {},
): UnitInventoryEntry {
  return {
    id, roomTypeId, type: opts.type ?? roomTypeId, level: opts.level ?? 1,
    x: 0, y: 0, z: 0, price: opts.price ?? 100,
    available: opts.available ?? true, name: opts.name ?? `Unit ${id}`,
    view: opts.view,
  }
}

describe("normalizeInventory", () => {
  it("drops malformed entries and unknown room types", () => {
    const out = normalizeInventory([
      { id: 1, roomTypeId: "r1", price: 100 },     // valid
      { id: "nope", roomTypeId: "r1" },            // bad id → dropped
      { id: 2, roomTypeId: "zzz" },                // unknown room id → dropped
      { id: 3 },                                   // no roomTypeId / type → dropped
    ])
    expect(out.map((u) => u.id)).toEqual([1])
    expect(out[0].roomTypeId).toBe("r1")
  })

  it("resolves roomTypeId from the explicit field and from UNIT_TYPE_TO_ROOM_ID", () => {
    UNIT_TYPE_TO_ROOM_ID["lake-view-king"] = "r2"
    const out = normalizeInventory([
      { id: 10, roomTypeId: "r1" },                // explicit
      { id: 11, type: "lake-view-king" },          // via type lookup
      { id: 12, type: "unmapped-type" },           // no mapping → dropped
    ])
    expect(out.map((u) => [u.id, u.roomTypeId])).toEqual([
      [10, "r1"],
      [11, "r2"],
    ])
    delete UNIT_TYPE_TO_ROOM_ID["lake-view-king"]
  })

  it("returns [] for non-array input", () => {
    expect(normalizeInventory(null)).toEqual([])
    expect(normalizeInventory({})).toEqual([])
  })
})

describe("reconcileToPlan", () => {
  const inv = [
    unit(1, "r1", { price: 100, level: 1 }),
    unit(2, "r1", { price: 200, level: 2 }),
    unit(3, "r1", { price: 150, level: 1 }),
  ]

  it("auto-fills to capacity, cheapest first (then level)", () => {
    const sel = reconcileToPlan(EMPTY_SELECTION, { r1: 2 }, inv)
    expect(sel.buckets.r1).toEqual([1, 3])   // 100, then 150 (cheaper than 200)
    expect(sel.activeUnitId).toBe(1)
  })

  it("trims an oversized bucket keeping the most-recent entries", () => {
    const start: UnitSelectionState = { buckets: { r1: [1, 2, 3] }, activeUnitId: 1 }
    const sel = reconcileToPlan(start, { r1: 2 }, inv)
    expect(sel.buckets.r1).toEqual([2, 3])
    expect(sel.activeUnitId).toBe(2)          // 1 was dropped → refocus survivor
  })

  it("clears buckets for types removed from the plan", () => {
    const start: UnitSelectionState = { buckets: { r1: [1], r2: [99] }, activeUnitId: 99 }
    const sel = reconcileToPlan(start, { r1: 1 }, inv)
    expect(sel.buckets.r2).toBeUndefined()
    expect(sel.buckets.r1).toEqual([1])
    expect(sel.activeUnitId).toBe(1)          // 99 gone → refocus
  })

  it("fixes activeUnitId when the focused unit is no longer selected", () => {
    const start: UnitSelectionState = { buckets: { r1: [1] }, activeUnitId: 555 }
    const sel = reconcileToPlan(start, { r1: 1 }, inv)
    expect(sel.activeUnitId).toBe(1)
  })

  it("excludes unavailable units from auto-fill", () => {
    const inv2 = [
      unit(1, "r1", { price: 100, available: false }),
      unit(2, "r1", { price: 200 }),
    ]
    const sel = reconcileToPlan(EMPTY_SELECTION, { r1: 1 }, inv2)
    expect(sel.buckets.r1).toEqual([2])
  })
})

describe("tapUnit — headline FIFO behavior", () => {
  it("per-type FIFO eviction, swap, and refocus-without-eviction", () => {
    // Start: standard (r1) cap 2 with two units, loft (r2) cap 1 with one unit.
    let sel: UnitSelectionState = { buckets: { r1: [101, 102], r2: [201] }, activeUnitId: 201 }

    // Tap a 3rd standard → oldest (101) evicted, last two kept, tapped is active.
    sel = tapUnit(sel, 103, "r1", 2)
    expect(sel.buckets.r1).toEqual([102, 103])
    expect(sel.activeUnitId).toBe(103)

    // Tap a 2nd loft (cap 1) → swaps: old loft evicted, new one kept + focused.
    sel = tapUnit(sel, 202, "r2", 1)
    expect(sel.buckets.r2).toEqual([202])
    expect(sel.activeUnitId).toBe(202)

    // Tap an already-selected unit → no eviction, just refocus.
    sel = tapUnit(sel, 102, "r1", 2)
    expect(sel.buckets.r1).toEqual([102, 103])   // unchanged
    expect(sel.activeUnitId).toBe(102)
  })

  it("creates a bucket for a fresh type and focuses the tapped unit", () => {
    const sel = tapUnit(EMPTY_SELECTION, 5, "r3", 1)
    expect(sel.buckets.r3).toEqual([5])
    expect(sel.activeUnitId).toBe(5)
    expect(selectedUnitIds(sel)).toEqual([5])
  })
})

describe("deselectUnit", () => {
  it("removes the unit and refocuses a survivor", () => {
    const start: UnitSelectionState = { buckets: { r1: [1, 2] }, activeUnitId: 1 }
    const sel = deselectUnit(start, 1, "r1")
    expect(sel.buckets.r1).toEqual([2])
    expect(sel.activeUnitId).toBe(2)
  })

  it("drops the bucket entirely when emptied and clears focus", () => {
    const start: UnitSelectionState = { buckets: { r1: [1] }, activeUnitId: 1 }
    const sel = deselectUnit(start, 1, "r1")
    expect(sel.buckets.r1).toBeUndefined()
    expect(sel.activeUnitId).toBeNull()
  })
})

describe("computeSelectionTotals", () => {
  it("uses selected unit prices, catalog fallback for unfilled slots", () => {
    const inv = [unit(1, "r1", { price: 100 })]
    const byId = inventoryById(inv)
    const sel: UnitSelectionState = { buckets: { r1: [1] }, activeUnitId: 1 }
    const { totalPerNight, capacity } = computeSelectionTotals(
      [{ roomId: "r1", quantity: 2 }], sel, byId,
    )
    // slot 0 = unit price 100; slot 1 unfilled → catalog r1 price 249.
    expect(totalPerNight).toBe(349)
    // capacity stays catalog-derived: occupancy 2 × quantity 2 = 4.
    expect(capacity).toBe(4)
  })

  it("falls back fully to catalog when no units are selected", () => {
    const { totalPerNight } = computeSelectionTotals(
      [{ roomId: "r1", quantity: 1 }], EMPTY_SELECTION, new Map(),
    )
    expect(totalPerNight).toBe(249)
  })
})
