import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { listArticlesQuerySchema, toListArticlesQuery } from "./schema.js"

describe("toListArticlesQuery", () => {
  it("includeStock=false anula conStock/sinStock/stockNegativo y deja ventaSinStock", () => {
    const parsed = listArticlesQuerySchema.parse({
      includeStock: "false",
      conStock: "true",
      sinStock: "true",
      stockNegativo: "true",
      ventaSinStock: "true",
    })
    const query = toListArticlesQuery(parsed)
    assert.equal(query.includeStock, false)
    assert.equal(query.conStock, false)
    assert.equal(query.sinStock, false)
    assert.equal(query.stockNegativo, false)
    assert.equal(query.ventaSinStock, true)
  })

  it("sin includeStock sigue consultando stock y honra los filtros", () => {
    const parsed = listArticlesQuerySchema.parse({
      conStock: "true",
    })
    const query = toListArticlesQuery(parsed)
    assert.equal(query.includeStock, true)
    assert.equal(query.conStock, true)
  })
})
