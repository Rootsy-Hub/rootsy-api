import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { z } from "zod"
import {
  PATCH_AT_LEAST_ONE_FIELD,
  mergePatch,
  parsePatchBody,
} from "./patchBody.js"

const upsert = z.object({
  name: z.string(),
  description: z.string().optional().default(""),
  salePrice: z.number(),
  isActive: z.boolean(),
})

describe("parsePatchBody", () => {
  it("acepta un solo campo y no rellena defaults", () => {
    const parsed = parsePatchBody(upsert, { salePrice: 6000 })
    assert.equal(parsed.success, true)
    if (!parsed.success) return
    assert.deepEqual(parsed.data, { salePrice: 6000 })
  })

  it("rechaza body vacío o sin campos del schema", () => {
    assert.equal(parsePatchBody(upsert, {}).success, false)
    assert.equal(parsePatchBody(upsert, { desconocido: 1 }).success, false)
    const empty = parsePatchBody(upsert, {})
    if (!empty.success) {
      assert.equal(empty.error, PATCH_AT_LEAST_ONE_FIELD)
    }
  })

  it("mezcla el parche sobre el recurso actual", () => {
    const current = {
      name: "Coca",
      description: "500 ml",
      salePrice: 4000,
      isActive: true,
    }
    const parsed = parsePatchBody(upsert, { salePrice: 6000 })
    assert.equal(parsed.success, true)
    if (!parsed.success) return
    assert.deepEqual(mergePatch(current, parsed.data), {
      name: "Coca",
      description: "500 ml",
      salePrice: 6000,
      isActive: true,
    })
  })
})
