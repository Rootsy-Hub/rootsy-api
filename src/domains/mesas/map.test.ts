import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mapSession } from "./map.ts"

const row = {
  id: "s1",
  dining_table_id: "t1",
  waiter_user_id: "w1",
  guest_count: 2,
  notes: "nota",
  opened_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:01:00.000Z",
  metadata: {
    floor_status: "paying",
    checkout: { carrito: [{ productoId: "a1", cantidad: 1 }] },
  },
  table_session_tables: [] as { dining_table_id: string }[],
}

describe("mapSession", () => {
  it("el listado del piso no incluye checkout", () => {
    const session = mapSession(row, { includeCheckout: false })
    assert.equal(session.checkout, null)
    assert.equal(session.floorStatus, "paying")
    assert.deepEqual(session.tableIds, ["t1"])
  })

  it("el GET de resumen incluye checkout", () => {
    const session = mapSession(row)
    assert.deepEqual(session.checkout, {
      carrito: [{ productoId: "a1", cantidad: 1 }],
    })
  })
})
