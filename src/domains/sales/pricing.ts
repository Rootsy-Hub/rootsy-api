export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

export type DiscountMode = "porcentaje" | "fijo"

export type SaleDiscountSource =
  | "none"
  | "catalog"
  | "manual"
  | "quantity_deal"
  | "combo"

export function articleHasCatalogDiscount(
  mode: DiscountMode | null | undefined,
  value: number | null | undefined,
): boolean {
  return (
    (mode === "porcentaje" || mode === "fijo") &&
    value != null &&
    Number.isFinite(value) &&
    value > 0
  )
}

export function effectiveArticleSalePrice(
  salePrice: number,
  mode: DiscountMode | null | undefined,
  value: number | null | undefined,
): number {
  const base = Number.isFinite(salePrice) ? salePrice : 0
  if (!articleHasCatalogDiscount(mode, value)) return roundMoney(base)
  const v = Number(value)
  if (mode === "porcentaje") {
    const pct = Math.min(100, Math.max(0, v))
    return roundMoney(base * (1 - pct / 100))
  }
  return roundMoney(Math.max(0, base - v))
}

export function parseManualDiscountValue(draft: string): number | null {
  const n = Number.parseFloat(draft.trim().replace(",", "."))
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

export function resolveSaleLineDiscount(input: {
  listUnitPrice: number
  quantity: number
  catalogDiscountMode?: DiscountMode | null
  catalogDiscountValue?: number | null
  manualMode?: DiscountMode
  manualDraft?: string
  suppressCatalogDiscount?: boolean
}): {
  listLineSubtotal: number
  lineSubtotal: number
  itemDiscountAmount: number
  itemDiscountMode: DiscountMode | null
  itemDiscountValue: number | null
  discountSource: SaleDiscountSource
} {
  const qty = Math.max(0, input.quantity)
  const listUnit = Math.max(0, Number(input.listUnitPrice) || 0)
  const listLineSubtotal = roundMoney(listUnit * qty)
  const manualValue = input.manualDraft
    ? parseManualDiscountValue(input.manualDraft)
    : null

  if (manualValue != null && input.manualMode) {
    const modo = input.manualMode
    const itemDiscountAmount =
      modo === "porcentaje"
        ? roundMoney(
            listLineSubtotal * (Math.min(100, Math.max(0, manualValue)) / 100),
          )
        : roundMoney(Math.min(Math.max(0, manualValue), listLineSubtotal))
    return {
      listLineSubtotal,
      lineSubtotal: roundMoney(listLineSubtotal - itemDiscountAmount),
      itemDiscountAmount,
      itemDiscountMode: modo,
      itemDiscountValue: manualValue,
      discountSource: "manual",
    }
  }

  if (
    !input.suppressCatalogDiscount &&
    articleHasCatalogDiscount(
      input.catalogDiscountMode,
      input.catalogDiscountValue,
    )
  ) {
    const effectiveUnit = effectiveArticleSalePrice(
      listUnit,
      input.catalogDiscountMode,
      input.catalogDiscountValue,
    )
    const lineSubtotal = roundMoney(effectiveUnit * qty)
    return {
      listLineSubtotal,
      lineSubtotal,
      itemDiscountAmount: roundMoney(listLineSubtotal - lineSubtotal),
      itemDiscountMode: input.catalogDiscountMode ?? null,
      itemDiscountValue: input.catalogDiscountValue ?? null,
      discountSource: "catalog",
    }
  }

  return {
    listLineSubtotal,
    lineSubtotal: listLineSubtotal,
    itemDiscountAmount: 0,
    itemDiscountMode: null,
    itemDiscountValue: null,
    discountSource: "none",
  }
}

export type ComboSelection = {
  slotId: string
  slotLabel: string
  kind: "article" | "recipe"
  refId: string
  name: string
  listUnitPrice: number
  slotQuantity: number
  iva: number
}

export function priceComboFromSnapshot(input: {
  unitPrice: number
  quantity: number
  selections: ComboSelection[]
  listTotal?: number | null
}): {
  listTotal: number
  promoTotal: number
  promoDiscount: number
  weightedIvaPct: number
  components: Array<
    ComboSelection & {
      listLineSubtotal: number
      allocatedLineSubtotal: number
      promoDiscount: number
      allocatedUnitPrice: number
    }
  >
} {
  const qty = Math.max(1, input.quantity)
  const expanded: ComboSelection[] = []
  for (const sel of input.selections) {
    const repeats = Math.max(1, Math.round(sel.slotQuantity))
    for (let i = 0; i < repeats; i++) {
      expanded.push({ ...sel, slotQuantity: 1 })
    }
  }
  const perCombo = expanded.map((sel) => ({
    sel,
    listLineSubtotal: roundMoney(sel.listUnitPrice * sel.slotQuantity),
  }))
  const listTotalPerCombo =
    input.listTotal != null && input.listTotal > 0
      ? roundMoney(input.listTotal / qty)
      : roundMoney(perCombo.reduce((sum, c) => sum + c.listLineSubtotal, 0))
  const promoTotalPerCombo = roundMoney(Math.max(0, input.unitPrice))
  const promoDiscountPerCombo = roundMoney(
    Math.max(0, listTotalPerCombo - promoTotalPerCombo),
  )
  const components = perCombo.map(({ sel, listLineSubtotal }) => {
    const weight =
      listTotalPerCombo > 0 ? listLineSubtotal / listTotalPerCombo : 0
    const allocatedLineSubtotal = roundMoney(promoTotalPerCombo * weight)
    return {
      ...sel,
      listLineSubtotal,
      allocatedLineSubtotal,
      promoDiscount: roundMoney(listLineSubtotal - allocatedLineSubtotal),
      allocatedUnitPrice:
        sel.slotQuantity > 0
          ? roundMoney(allocatedLineSubtotal / sel.slotQuantity)
          : 0,
    }
  })
  const ivaWeight = components.reduce(
    (sum, c) => sum + c.allocatedLineSubtotal * (c.iva || 0),
    0,
  )
  const allocatedSum = components.reduce(
    (sum, c) => sum + c.allocatedLineSubtotal,
    0,
  )
  return {
    listTotal: roundMoney(listTotalPerCombo * qty),
    promoTotal: roundMoney(promoTotalPerCombo * qty),
    promoDiscount: roundMoney(promoDiscountPerCombo * qty),
    weightedIvaPct:
      allocatedSum > 0 ? roundMoney(ivaWeight / allocatedSum) : 0,
    components,
  }
}
