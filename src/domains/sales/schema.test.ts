import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createSaleBodySchema, createSaleLineSchema } from "./schema.js"

const articleId = "11111111-1111-4111-8111-111111111111"
const recipeId = "22222222-2222-4222-8222-222222222222"

function line(overrides: Record<string, unknown> = {}) {
  return {
    articleId,
    quantity: 1,
    snapshot: { name: "Café", unitPrice: 1200 },
    ...overrides,
  }
}

describe("createSaleLineSchema", () => {
  it("exige snapshot y un solo tipo de línea", () => {
    const parsed = createSaleLineSchema.parse(line())
    assert.equal(parsed.snapshot.name, "Café")
    assert.equal(parsed.articleId, articleId)
    assert.throws(
      () => createSaleLineSchema.parse({ quantity: 1 }),
      /Required|snapshot|invalid/i,
    )
    assert.throws(
      () =>
        createSaleLineSchema.parse(
          line({ articleId, recipeId, promotionId: undefined }),
        ),
      /artículo, receta o promoción/,
    )
  })
})

describe("createSaleBodySchema", () => {
  it("pide idempotencia y defaulta canal POS", () => {
    const parsed = createSaleBodySchema.parse({
      idempotencyKey: "sale-key-01",
      lines: [line()],
      generalDiscountMode: "porcentaje",
    })
    assert.equal(parsed.channel.type, "pos")
    assert.equal(parsed.idempotencyKey, "sale-key-01")
    assert.throws(
      () =>
        createSaleBodySchema.parse({
          idempotencyKey: "short",
          lines: [line()],
          generalDiscountMode: "porcentaje",
        }),
    )
  })

  it("acepta canal mesa", () => {
    const parsed = createSaleBodySchema.parse({
      idempotencyKey: "table-sale-key",
      lines: [line({ quantity: 2 })],
      generalDiscountMode: "fijo",
      valorDescuentoFijo: 0,
      channel: {
        type: "table",
        sessionId: "33333333-3333-4333-8333-333333333333",
        closeOnComplete: true,
      },
    })
    assert.equal(parsed.channel.type, "table")
    if (parsed.channel.type === "table") {
      assert.equal(parsed.channel.closeOnComplete, true)
    }
  })
})
