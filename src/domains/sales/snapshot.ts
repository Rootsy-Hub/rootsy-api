import { roundMoney, type DiscountMode, type SaleDiscountSource } from "./pricing.js"

export const SALE_SNAPSHOT_VERSION = 2

export type SaleDisplayGroupType = "product" | "promotion" | "discount"

type LineForSnapshot = {
  qty: number
  unitPrice: number
  listLineTotal?: number | null
  itemDiscount: number
  discountSource: SaleDiscountSource
  promotionDealName: string | null
  name: string
  lineGroupId: string | null
  lineKind: "article" | "recipe" | "promotion"
  itemDiscountMode: DiscountMode | null
  itemDiscountValue: number | null
}

function catalogDiscountLabel(
  mode: DiscountMode | null,
  value: number | null,
): string | null {
  if (mode === "porcentaje" && value != null) {
    return `${Number.isInteger(value) ? value : value.toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`
  }
  if (mode === "fijo" && value != null) return "Descuento fijo"
  return null
}

export function buildLineDisplay(line: LineForSnapshot, sortOrder: number) {
  if (line.lineKind === "promotion") {
    return {
      groupId: `combo:${line.name}`,
      groupLabel: line.name,
      groupType: "promotion" as SaleDisplayGroupType,
      sortOrder,
    }
  }
  if (line.discountSource === "quantity_deal" && line.lineGroupId) {
    return {
      groupId: line.lineGroupId,
      groupLabel: line.promotionDealName?.trim() || "Promoción",
      groupType: "promotion" as SaleDisplayGroupType,
      sortOrder,
    }
  }
  if (line.discountSource === "catalog") {
    const label = catalogDiscountLabel(line.itemDiscountMode, line.itemDiscountValue)
    return {
      groupId:
        line.lineGroupId && !line.lineGroupId.startsWith("qtydeal:")
          ? line.lineGroupId
          : `discount:catalog:${sortOrder}`,
      groupLabel: label ? `Catálogo ${label}` : "Descuento catálogo",
      groupType: "discount" as SaleDisplayGroupType,
      sortOrder,
    }
  }
  if (line.discountSource === "manual" && line.itemDiscount > 0) {
    const label = catalogDiscountLabel(line.itemDiscountMode, line.itemDiscountValue)
    return {
      groupId:
        line.lineGroupId && !line.lineGroupId.startsWith("qtydeal:")
          ? line.lineGroupId
          : `discount:manual:${sortOrder}`,
      groupLabel: label ?? "Descuento manual",
      groupType: "discount" as SaleDisplayGroupType,
      sortOrder,
    }
  }
  return {
    groupId: null as string | null,
    groupLabel: null as string | null,
    groupType: "product" as SaleDisplayGroupType,
    sortOrder,
  }
}

export function computeSnapshotTotals(input: {
  lines: LineForSnapshot[]
  generalDiscount: number
  taxTotal: number
  total: number
  netSubtotalBeforeGeneral: number
}) {
  let listSubtotal = 0
  let discountPromotionsAmount = 0
  let discountItemsCatalogAmount = 0
  let discountItemsManualAmount = 0
  for (const line of input.lines) {
    const list =
      line.listLineTotal != null && line.listLineTotal > 0
        ? roundMoney(line.listLineTotal)
        : roundMoney(line.qty * line.unitPrice)
    listSubtotal += list
    if (line.discountSource === "combo" || line.discountSource === "quantity_deal") {
      discountPromotionsAmount += line.itemDiscount
    } else if (line.discountSource === "catalog") {
      discountItemsCatalogAmount += line.itemDiscount
    } else if (line.discountSource === "manual") {
      discountItemsManualAmount += line.itemDiscount
    }
  }
  return {
    listSubtotal: roundMoney(listSubtotal),
    discountPromotionsAmount: roundMoney(discountPromotionsAmount),
    discountItemsCatalogAmount: roundMoney(discountItemsCatalogAmount),
    discountItemsManualAmount: roundMoney(discountItemsManualAmount),
    discountGeneralAmount: roundMoney(input.generalDiscount),
    netSubtotalBeforeGeneral: roundMoney(input.netSubtotalBeforeGeneral),
    taxTotal: roundMoney(input.taxTotal),
    total: roundMoney(input.total),
  }
}

export function snapshotTotalsToMetadata(
  totals: ReturnType<typeof computeSnapshotTotals>,
): Record<string, number> {
  return {
    list_subtotal: totals.listSubtotal,
    discount_promotions_amount: totals.discountPromotionsAmount,
    discount_items_catalog_amount: totals.discountItemsCatalogAmount,
    discount_items_manual_amount: totals.discountItemsManualAmount,
    discount_general_amount: totals.discountGeneralAmount,
    net_subtotal_before_general: totals.netSubtotalBeforeGeneral,
    tax_total: totals.taxTotal,
    total: totals.total,
  }
}

export function saleComprobanteAccruesOutputVat(label: string | null | undefined): boolean {
  if (label == null || label === "Recibo X") return false
  if (label.startsWith("Recibo")) return false
  if (label.startsWith("Factura")) return true
  if (label.startsWith("Nota de cr")) return true
  if (label.startsWith("Nota de d")) return true
  return false
}
