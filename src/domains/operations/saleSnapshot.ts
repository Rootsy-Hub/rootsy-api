export type SaleDisplayGroupType = "product" | "promotion" | "discount"

export type SaleSnapshotTotals = {
  listSubtotal: number
  discountPromotionsAmount: number
  discountItemsCatalogAmount: number
  discountItemsManualAmount: number
  discountGeneralAmount: number
  netSubtotalBeforeGeneral: number
  taxTotal: number
  total: number
}

export type SaleLineDisplay = {
  groupId: string | null
  groupLabel: string | null
  groupType: SaleDisplayGroupType
  sortOrder: number
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export function parseLineDisplay(raw: unknown): SaleLineDisplay | null {
  if (raw == null || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const groupTypeRaw = o.group_type
  const groupType: SaleDisplayGroupType =
    groupTypeRaw === "product" ||
    groupTypeRaw === "promotion" ||
    groupTypeRaw === "discount"
      ? groupTypeRaw
      : "product"
  return {
    groupId:
      typeof o.group_id === "string" && o.group_id.trim()
        ? o.group_id.trim()
        : null,
    groupLabel:
      typeof o.group_label === "string" && o.group_label.trim()
        ? o.group_label.trim()
        : null,
    groupType,
    sortOrder: Number(o.sort_order ?? 0) || 0,
  }
}

export function parseSnapshotTotals(raw: unknown): SaleSnapshotTotals | null {
  if (raw == null || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  return {
    listSubtotal: roundMoney(Number(o.list_subtotal ?? 0) || 0),
    discountPromotionsAmount: roundMoney(
      Number(o.discount_promotions_amount ?? 0) || 0,
    ),
    discountItemsCatalogAmount: roundMoney(
      Number(o.discount_items_catalog_amount ?? 0) || 0,
    ),
    discountItemsManualAmount: roundMoney(
      Number(o.discount_items_manual_amount ?? 0) || 0,
    ),
    discountGeneralAmount: roundMoney(
      Number(o.discount_general_amount ?? 0) || 0,
    ),
    netSubtotalBeforeGeneral: roundMoney(
      Number(o.net_subtotal_before_general ?? 0) || 0,
    ),
    taxTotal: roundMoney(Number(o.tax_total ?? 0) || 0),
    total: roundMoney(Number(o.total ?? 0) || 0),
  }
}
