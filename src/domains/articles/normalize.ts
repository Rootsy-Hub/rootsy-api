import {
  ARTICLE_IVA_RATES,
  MAX_CUSTOM_UNIT_OF_MEASURE_LENGTH,
  UNIT_OF_MEASURE_VALUES,
  type ArticleDiscountMode,
  type ArticleItemKind,
  type CostLineInput,
  type UpsertArticleBody,
} from "./schema.js"

export function isValidStoredUnitOfMeasure(v: string): boolean {
  const trimmed = v.trim()
  if (!trimmed) return false
  if ((UNIT_OF_MEASURE_VALUES as readonly string[]).includes(trimmed)) {
    return true
  }
  return trimmed.length <= MAX_CUSTOM_UNIT_OF_MEASURE_LENGTH
}

export function isAllowedArticleIvaRate(iva: number): boolean {
  return ARTICLE_IVA_RATES.some((rate) => Math.abs(rate - iva) < 0.001)
}

export function defaultIsSellableForKind(kind: ArticleItemKind): boolean {
  return kind === "merchandise"
}

export function normalizeArticleSku(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return null
  return trimmed.slice(0, 64)
}

export function normalizeArticleBarcode(
  raw: string | null | undefined,
): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "")
  if (!digits) return null
  if (digits.length < 8 || digits.length > 14) return null
  return digits
}

export function validateArticleBarcodeInput(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return { ok: true, value: null }
  const normalized = normalizeArticleBarcode(trimmed)
  if (!normalized) {
    return {
      ok: false,
      error: "El código de barras debe tener entre 8 y 14 dígitos (EAN/UPC).",
    }
  }
  return { ok: true, value: normalized }
}

export function articleDeleteConfirmPhrase(articleName: string): string {
  const name = articleName.trim() || "este artículo"
  return `Eliminar ${name}`
}

export function normalizeIdentifierFields(input: {
  itemKind: ArticleItemKind
  sku: string
  barcode: string
}):
  | { ok: true; sku: string | null; barcode: string | null }
  | { ok: false; error: string } {
  const sku = normalizeArticleSku(input.sku)
  if (input.itemKind !== "merchandise") {
    return { ok: true, sku, barcode: null }
  }
  const barcodeRes = validateArticleBarcodeInput(input.barcode)
  if (!barcodeRes.ok) return barcodeRes
  return { ok: true, sku, barcode: barcodeRes.value }
}

export function normalizeCatalogFields(input: {
  itemKind: ArticleItemKind
  brand: string
  discountMode: ArticleDiscountMode | null
  discountValue: number | null
}):
  | {
      ok: true
      fields: {
        brand: string
        discountMode: ArticleDiscountMode | null
        discountValue: number | null
      }
    }
  | { ok: false; error: string } {
  const brand = input.brand.trim()
  if (input.itemKind !== "merchandise") {
    return {
      ok: true,
      fields: { brand, discountMode: null, discountValue: null },
    }
  }

  let discountMode = input.discountMode
  let discountValue = input.discountValue
  if (discountMode && (discountValue == null || discountValue <= 0)) {
    return { ok: false, error: "Indicá el monto o porcentaje del descuento." }
  }
  if (!discountMode || discountValue == null || discountValue <= 0) {
    discountMode = null
    discountValue = null
  } else if (discountMode === "porcentaje" && discountValue > 100) {
    return { ok: false, error: "El descuento porcentual no puede superar 100 %." }
  }

  return { ok: true, fields: { brand, discountMode, discountValue } }
}

export function articleDbPayloadFromInput(input: UpsertArticleBody & {
  brand: string
  sku: string
  barcode: string
  discountMode: ArticleDiscountMode | null
  discountValue: number | null
}) {
  return {
    item_kind: input.itemKind,
    unit_of_measure: input.unitOfMeasure.trim(),
    is_sellable: defaultIsSellableForKind(input.itemKind),
    default_waste_pct: input.defaultWastePct,
    min_stock_level: input.minStockLevel,
    track_stock: true,
    brand: input.brand.trim(),
    sku: normalizeArticleSku(input.sku),
    barcode:
      input.itemKind === "merchandise"
        ? normalizeArticleBarcode(input.barcode)
        : null,
    discount_mode: input.discountMode,
    discount_value: input.discountValue,
    allow_negative_stock:
      input.itemKind === "merchandise" ? input.allowNegativeStock : false,
  }
}

function normalizeCostLine(raw: CostLineInput): CostLineInput | null {
  const costUnitLabel = raw.costUnitLabel.trim()
  const name = (raw.name ?? "").trim()
  const saleUnitsPerCostUnit = Number(raw.saleUnitsPerCostUnit)
  const unitPrice = Number(raw.unitPrice)
  const supplierId = raw.supplierId?.trim() || null
  const isEmpty =
    !costUnitLabel &&
    !name &&
    !Number.isFinite(saleUnitsPerCostUnit) &&
    !Number.isFinite(unitPrice) &&
    !supplierId
  if (isEmpty) return null
  return {
    name,
    costUnitLabel,
    saleUnitsPerCostUnit,
    unitPrice,
    supplierId,
    isActive: raw.isActive !== false,
  }
}

export function validateArticleCostLines(
  lines: CostLineInput[],
): { ok: true; lines: CostLineInput[] } | { ok: false; error: string } {
  const normalized = lines
    .map(normalizeCostLine)
    .filter((line): line is CostLineInput => line != null)

  for (let i = 0; i < normalized.length; i += 1) {
    const line = normalized[i]
    const row = i + 1
    if (!line.costUnitLabel.trim()) {
      return {
        ok: false,
        error: `Costo ${row}: indicá la unidad de compra (ej. maple de 32).`,
      }
    }
    const factor = Number(line.saleUnitsPerCostUnit)
    if (!Number.isFinite(factor) || factor <= 0) {
      return {
        ok: false,
        error: `Costo ${row}: la equivalencia debe ser mayor que cero.`,
      }
    }
    const price = Number(line.unitPrice)
    if (!Number.isFinite(price) || price < 0) {
      return {
        ok: false,
        error: `Costo ${row}: el precio de la unidad de compra no es válido.`,
      }
    }
  }

  return { ok: true, lines: normalized }
}

function unitCostInSaleUom(cost: {
  unitPrice: number
  saleUnitsPerCostUnit: number
}): number {
  const factor = cost.saleUnitsPerCostUnit
  if (!Number.isFinite(factor) || factor <= 0) return 0
  return Math.round((cost.unitPrice / factor) * 100) / 100
}

export function primarySaleUnitCostFromCosts(
  costs: CostLineInput[],
): number | null {
  for (const cost of costs) {
    if (cost.isActive === false) continue
    if (cost.unitPrice <= 0) continue
    const unit = unitCostInSaleUom(cost)
    if (unit > 0) return unit
  }
  return null
}
