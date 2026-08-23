import type { SaleCatalogArticle } from "./schema.js"

export const SALE_CATALOG_ARTICLE_SELECT = `
  id,
  name,
  description,
  sale_price,
  iva,
  discount_mode,
  discount_value,
  category_id,
  unit_of_measure,
  image_url,
  barcode,
  categories ( id, name )
` as const

function isDiscountMode(v: string): v is "porcentaje" | "fijo" {
  return v === "porcentaje" || v === "fijo"
}

function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function hasCatalogDiscount(
  mode: "porcentaje" | "fijo" | null,
  value: number | null,
): boolean {
  return mode != null && value != null && Number.isFinite(value) && value > 0
}

function effectiveSalePrice(
  salePrice: number,
  mode: "porcentaje" | "fijo" | null,
  value: number | null,
): number {
  const base = Number.isFinite(salePrice) ? salePrice : 0
  if (!hasCatalogDiscount(mode, value)) return roundMoney(base)
  const v = Number(value)
  if (mode === "porcentaje") {
    const pct = Math.min(100, Math.max(0, v))
    return roundMoney(base * (1 - pct / 100))
  }
  return roundMoney(Math.max(0, base - v))
}

export function mapSaleCatalogArticleRow(
  row: Record<string, unknown>,
  listPriceOverride?: number,
): SaleCatalogArticle {
  const cat = row.categories as { name?: string } | null
  const principal = Number(row.sale_price ?? 0) || 0
  const listPrice =
    listPriceOverride != null && Number.isFinite(listPriceOverride)
      ? listPriceOverride
      : principal
  const rawDiscountMode = row.discount_mode
  const discountMode =
    typeof rawDiscountMode === "string" && isDiscountMode(rawDiscountMode)
      ? rawDiscountMode
      : null
  const discountRaw = row.discount_value
  const discountValue =
    discountRaw != null && Number.isFinite(Number(discountRaw))
      ? Number(discountRaw)
      : null
  const hasDiscount = hasCatalogDiscount(discountMode, discountValue)
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    salePrice: effectiveSalePrice(listPrice, discountMode, discountValue),
    originalSalePrice: hasDiscount ? listPrice : undefined,
    discountMode: hasDiscount ? discountMode : null,
    discountValue: hasDiscount ? discountValue : null,
    iva: Number(row.iva ?? 0) || 0,
    categoryId: String(row.category_id ?? ""),
    categoryName: cat?.name ? String(cat.name) : "—",
    unitOfMeasure: String(row.unit_of_measure ?? "unidad"),
    imageUrl:
      typeof row.image_url === "string" && row.image_url.trim()
        ? row.image_url.trim()
        : null,
    barcode:
      row.barcode != null && String(row.barcode).trim()
        ? String(row.barcode).trim()
        : null,
  }
}

export function effectiveArticlePrice(
  salePrice: number,
  discountMode: unknown,
  discountValue: unknown,
): number {
  const mode =
    typeof discountMode === "string" && isDiscountMode(discountMode)
      ? discountMode
      : null
  const value =
    discountValue != null && Number.isFinite(Number(discountValue))
      ? Number(discountValue)
      : null
  return effectiveSalePrice(Number(salePrice ?? 0) || 0, mode, value)
}
