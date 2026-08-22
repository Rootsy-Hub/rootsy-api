import type {
  PurchaseOrderDetail,
  PurchaseOrderMetadata,
  PurchaseOrderTableRow,
} from "./schema.js"

export function parsePurchaseOrderMetadata(raw: unknown): PurchaseOrderMetadata {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {}
  }
  const row = raw as Record<string, unknown>
  const lineSummaries = Array.isArray(row.lineSummaries)
    ? row.lineSummaries
        .map((line) => {
          if (line == null || typeof line !== "object" || Array.isArray(line)) {
            return null
          }
          const item = line as Record<string, unknown>
          const name = typeof item.name === "string" ? item.name : ""
          const quantity = Number(item.quantity)
          const unitPrice = Number(item.unitPrice)
          const lineTotal = Number(item.lineTotal)
          if (!name.trim()) return null
          return {
            name,
            quantity: Number.isFinite(quantity) ? quantity : 0,
            unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
            lineTotal: Number.isFinite(lineTotal) ? lineTotal : 0,
          }
        })
        .filter((line): line is NonNullable<typeof line> => line != null)
    : undefined

  return {
    comprobanteLabel:
      typeof row.comprobanteLabel === "string" ? row.comprobanteLabel : null,
    paymentLabel: typeof row.paymentLabel === "string" ? row.paymentLabel : null,
    discountLabel:
      typeof row.discountLabel === "string" ? row.discountLabel : null,
    lineSummaries,
  }
}

export function checkoutSnapshotHasItems(raw: unknown): boolean {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return false
  const carrito = (raw as Record<string, unknown>).carrito
  return Array.isArray(carrito) && carrito.length > 0
}

export function mapPurchaseOrderRow(
  row: Record<string, unknown>,
): PurchaseOrderTableRow {
  const metadata = parsePurchaseOrderMetadata(row.metadata)
  const itemCount =
    metadata.lineSummaries?.reduce((sum, line) => sum + line.quantity, 0) ?? 0

  return {
    id: String(row.id),
    orderNumber: Number(row.order_number) || 0,
    supplierName: String(row.supplier_name ?? ""),
    supplierTaxId:
      typeof row.supplier_tax_id === "string" ? row.supplier_tax_id : null,
    subtotal: Number(row.subtotal) || 0,
    discountTotal: Number(row.discount_total) || 0,
    total: Number(row.total) || 0,
    status:
      row.status === "converted" || row.status === "cancelled"
        ? row.status
        : "active",
    createdAt: String(row.created_at ?? ""),
    itemCount,
  }
}

export function mapPurchaseOrderDetail(
  row: Record<string, unknown>,
): PurchaseOrderDetail | null {
  if (!checkoutSnapshotHasItems(row.checkout_snapshot)) return null
  return {
    ...mapPurchaseOrderRow(row),
    supplierId: typeof row.supplier_id === "string" ? row.supplier_id : null,
    checkoutSnapshot: row.checkout_snapshot,
    metadata: parsePurchaseOrderMetadata(row.metadata),
  }
}
