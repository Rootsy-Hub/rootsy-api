import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  priceComboFromSnapshot,
  resolveSaleLineDiscount,
} from "./pricing.js"

describe("resolveSaleLineDiscount", () => {
  it("aplica descuento de catálogo sobre el precio de lista", () => {
    const priced = resolveSaleLineDiscount({
      listUnitPrice: 1000,
      quantity: 2,
      catalogDiscountMode: "porcentaje",
      catalogDiscountValue: 10,
    })
    assert.equal(priced.listLineSubtotal, 2000)
    assert.equal(priced.lineSubtotal, 1800)
    assert.equal(priced.itemDiscountAmount, 200)
    assert.equal(priced.discountSource, "catalog")
  })

  it("el manual pisa el de catálogo", () => {
    const priced = resolveSaleLineDiscount({
      listUnitPrice: 1000,
      quantity: 1,
      catalogDiscountMode: "porcentaje",
      catalogDiscountValue: 10,
      manualMode: "fijo",
      manualDraft: "150",
    })
    assert.equal(priced.lineSubtotal, 850)
    assert.equal(priced.itemDiscountAmount, 150)
    assert.equal(priced.discountSource, "manual")
  })

  it("suppressCatalogDiscount cobra el precio de lista", () => {
    const priced = resolveSaleLineDiscount({
      listUnitPrice: 1000,
      quantity: 1,
      catalogDiscountMode: "porcentaje",
      catalogDiscountValue: 10,
      suppressCatalogDiscount: true,
    })
    assert.equal(priced.lineSubtotal, 1000)
    assert.equal(priced.discountSource, "none")
  })
})

describe("priceComboFromSnapshot", () => {
  it("congela el combo y reparte el precio entre selecciones", () => {
    const priced = priceComboFromSnapshot({
      unitPrice: 2000,
      quantity: 1,
      listTotal: 3000,
      selections: [
        {
          slotId: "11111111-1111-4111-8111-111111111111",
          slotLabel: "Principal",
          kind: "recipe",
          refId: "22222222-2222-4222-8222-222222222222",
          name: "Milanesa",
          listUnitPrice: 2000,
          slotQuantity: 1,
          iva: 21,
        },
        {
          slotId: "33333333-3333-4333-8333-333333333333",
          slotLabel: "Bebida",
          kind: "article",
          refId: "44444444-4444-4444-8444-444444444444",
          name: "Gaseosa",
          listUnitPrice: 1000,
          slotQuantity: 1,
          iva: 21,
        },
      ],
    })
    assert.equal(priced.listTotal, 3000)
    assert.equal(priced.promoTotal, 2000)
    assert.equal(priced.promoDiscount, 1000)
    assert.equal(priced.components.length, 2)
    assert.equal(priced.components[0]?.allocatedLineSubtotal, 1333.33)
    assert.equal(priced.components[1]?.allocatedLineSubtotal, 666.67)
  })
})
