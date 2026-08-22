import type {
  SaleQuoteDetail,
  SaleQuoteLineDiscount,
  SaleQuoteLineGroup,
  SaleQuoteLineGroupLine,
  SaleQuoteMetadata,
  SaleQuoteTableRow,
} from "./schema.js"

function parseQuoteLineDiscount(raw: unknown): SaleQuoteLineDiscount | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const label = typeof item.label === "string" ? item.label : ""
  const amount = Number(item.amount)
  if (!label.trim() || !Number.isFinite(amount) || amount <= 0) return null
  return { label, amount }
}

function parseQuoteLineGroupLine(raw: unknown): SaleQuoteLineGroupLine | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const name = typeof item.name === "string" ? item.name : ""
  const quantity = Number(item.quantity)
  const unitListPrice = Number(item.unitListPrice ?? item.unitPrice)
  const listLineTotal = Number(item.listLineTotal ?? item.lineTotal)
  const lineTotal = Number(item.lineTotal)
  if (!name.trim()) return null
  const discounts = Array.isArray(item.discounts)
    ? item.discounts
        .map(parseQuoteLineDiscount)
        .filter((discount): discount is SaleQuoteLineDiscount => discount != null)
    : []

  return {
    name,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    unitListPrice: Number.isFinite(unitListPrice) ? unitListPrice : 0,
    listLineTotal: Number.isFinite(listLineTotal) ? listLineTotal : 0,
    lineTotal: Number.isFinite(lineTotal) ? lineTotal : 0,
    discounts,
  }
}

function parseQuoteLineGroups(raw: unknown): SaleQuoteLineGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const groups = raw
    .map((group) => {
      if (group == null || typeof group !== "object" || Array.isArray(group)) {
        return null
      }
      const row = group as Record<string, unknown>
      const id = typeof row.id === "string" ? row.id : ""
      const category = typeof row.category === "string" ? row.category : "General"
      const lines = Array.isArray(row.lines)
        ? row.lines
            .map(parseQuoteLineGroupLine)
            .filter((line): line is SaleQuoteLineGroupLine => line != null)
        : []
      if (lines.length === 0) return null
      return {
        id: id || `group:${category}`,
        category,
        lines,
        promotionDiscount: parseQuoteLineDiscount(row.promotionDiscount) ?? null,
      } satisfies SaleQuoteLineGroup
    })
    .filter((group): group is SaleQuoteLineGroup => group != null)

  return groups.length > 0 ? groups : undefined
}

export function parseQuoteMetadata(raw: unknown): SaleQuoteMetadata {
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
  const lineGroups = parseQuoteLineGroups(row.lineGroups)

  return {
    comprobanteLabel:
      typeof row.comprobanteLabel === "string" ? row.comprobanteLabel : null,
    paymentLabel: typeof row.paymentLabel === "string" ? row.paymentLabel : null,
    discountLabel:
      typeof row.discountLabel === "string" ? row.discountLabel : null,
    lineSummaries,
    lineGroups,
  }
}

export function quoteLineGroupsItemCount(groups: SaleQuoteLineGroup[]): number {
  return groups.reduce(
    (sum, group) =>
      sum + group.lines.reduce((lineSum, line) => lineSum + line.quantity, 0),
    0,
  )
}

export function mapQuoteRow(row: Record<string, unknown>): SaleQuoteTableRow {
  const metadata = parseQuoteMetadata(row.metadata)
  const itemCount =
    metadata.lineGroups != null
      ? quoteLineGroupsItemCount(metadata.lineGroups)
      : metadata.lineSummaries?.reduce((sum, line) => sum + line.quantity, 0)

  return {
    id: String(row.id),
    quoteNumber: Number(row.quote_number) || 0,
    customerName: String(row.customer_name ?? ""),
    customerTaxId:
      typeof row.customer_tax_id === "string" ? row.customer_tax_id : null,
    subtotal: Number(row.subtotal) || 0,
    discountTotal: Number(row.discount_total) || 0,
    total: Number(row.total) || 0,
    status:
      row.status === "converted" || row.status === "cancelled"
        ? row.status
        : "active",
    createdAt: String(row.created_at ?? ""),
    itemCount: itemCount ?? 0,
  }
}

export function checkoutSnapshotHasItems(raw: unknown): boolean {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return false
  const carrito = (raw as Record<string, unknown>).carrito
  return Array.isArray(carrito) && carrito.length > 0
}

export function mapQuoteDetail(
  row: Record<string, unknown>,
): SaleQuoteDetail | null {
  if (!checkoutSnapshotHasItems(row.checkout_snapshot)) return null
  return {
    ...mapQuoteRow(row),
    clientId: typeof row.client_id === "string" ? row.client_id : null,
    checkoutSnapshot: row.checkout_snapshot,
    metadata: parseQuoteMetadata(row.metadata),
  }
}
