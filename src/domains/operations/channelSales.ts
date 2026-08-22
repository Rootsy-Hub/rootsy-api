import type { OperationSaleRow } from "./schema.js"

export type ChannelSaleMetadata = {
  channelOrderTotal: number | null
  channelPaidAccumulated: number | null
  isPartialChannelPayment: boolean
}

export function parseChannelSaleMetadata(
  metadata: unknown,
): ChannelSaleMetadata {
  if (typeof metadata !== "object" || metadata == null) {
    return {
      channelOrderTotal: null,
      channelPaidAccumulated: null,
      isPartialChannelPayment: false,
    }
  }
  const row = metadata as Record<string, unknown>
  const orderTotal = Number(row.channel_order_total)
  const paidAccumulated = Number(row.channel_paid_accumulated)
  return {
    channelOrderTotal: Number.isFinite(orderTotal) ? orderTotal : null,
    channelPaidAccumulated: Number.isFinite(paidAccumulated)
      ? paidAccumulated
      : null,
    isPartialChannelPayment: row.partial_channel_payment === true,
  }
}

function sumMoney(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

function resolveOrderTotal(sales: OperationSaleRow[]): number {
  const fromMeta = sales.reduce<number | null>((best, sale) => {
    const candidate = sale.channelOrderTotal
    if (candidate == null) return best
    if (best == null) return candidate
    return Math.max(best, candidate)
  }, null)
  if (fromMeta != null) return fromMeta
  return sumMoney(sales.map((sale) => sale.saleAmount))
}

function resolvePaidTotal(sales: OperationSaleRow[]): number {
  const fromMeta = sales.reduce<number | null>((best, sale) => {
    const candidate = sale.channelPaidTotal
    if (candidate == null) return best
    if (best == null) return candidate
    return Math.max(best, candidate)
  }, null)
  if (fromMeta != null) return fromMeta
  return sumMoney(sales.flatMap((sale) => sale.payments).map((p) => p.amount))
}

function mergeDiscountInfo(
  sales: OperationSaleRow[],
): OperationSaleRow["discountInfo"] {
  const latest = sales[sales.length - 1]!
  const quantityDealApplications = new Map<
    string,
    OperationSaleRow["discountInfo"]["quantityDealApplications"][number]
  >()
  for (const sale of sales) {
    for (const deal of sale.discountInfo.quantityDealApplications) {
      quantityDealApplications.set(deal.promotionId, deal)
    }
  }
  return {
    ...latest.discountInfo,
    quantityDealApplications: [...quantityDealApplications.values()],
    itemDiscountTotal: sumMoney(
      sales.map((sale) => sale.discountInfo.itemDiscountTotal),
    ),
    generalDiscountAmount: sumMoney(
      sales.map((sale) => sale.discountInfo.generalDiscountAmount),
    ),
  }
}

export function groupChannelOperationSales(
  sales: OperationSaleRow[],
  view: "table" | "counter",
): OperationSaleRow[] {
  const groupKeyFor = (sale: OperationSaleRow): string | null => {
    if (view === "table") {
      return sale.tableSessionId?.trim() || null
    }
    return sale.counterOrderId?.trim() || null
  }

  const byGroup = new Map<string, OperationSaleRow[]>()
  const ungrouped: OperationSaleRow[] = []

  for (const sale of sales) {
    const key = groupKeyFor(sale)
    if (!key) {
      ungrouped.push(enrichSingleChannelSale(sale))
      continue
    }
    const bucket = byGroup.get(key) ?? []
    bucket.push(sale)
    byGroup.set(key, bucket)
  }

  const grouped: OperationSaleRow[] = []

  for (const [, bucket] of byGroup) {
    if (bucket.length === 1) {
      grouped.push(enrichSingleChannelSale(bucket[0]!))
      continue
    }

    const sorted = [...bucket].sort((a, b) => a.soldAt.localeCompare(b.soldAt))
    const latest = sorted[sorted.length - 1]!
    const orderTotal = resolveOrderTotal(sorted)
    const paidTotal = resolvePaidTotal(sorted)
    const payments = sorted.flatMap((sale) => sale.payments)

    grouped.push({
      ...latest,
      id: latest.id,
      tableLabel:
        sorted.find((sale) => sale.tableLabel)?.tableLabel ?? latest.tableLabel,
      counterOrderLabel:
        sorted.find((sale) => sale.counterOrderLabel)?.counterOrderLabel ??
        latest.counterOrderLabel,
      groupedSaleIds: sorted.map((sale) => sale.id),
      isChannelGrouped: true,
      channelOrderTotal: orderTotal,
      channelPaidTotal: paidTotal,
      saleAmount: paidTotal,
      total: orderTotal,
      subtotal: sumMoney(sorted.map((sale) => sale.subtotal)),
      taxTotal: sumMoney(sorted.map((sale) => sale.taxTotal)),
      discountTotal: sumMoney(sorted.map((sale) => sale.discountTotal)),
      lineItems: [],
      snapshotInfo: { version: null, totals: null },
      discountInfo: mergeDiscountInfo(sorted),
      payments,
      paymentMethodLabel: formatGroupedPaymentLabel(payments),
      soldAt: latest.soldAt,
      status: paidTotal + 0.009 < orderTotal ? "partial" : latest.status,
    })
  }

  return [...grouped, ...ungrouped].sort((a, b) =>
    b.soldAt.localeCompare(a.soldAt),
  )
}

function enrichSingleChannelSale(sale: OperationSaleRow): OperationSaleRow {
  const orderTotal = sale.channelOrderTotal ?? sale.saleAmount
  const paidTotal = sale.channelPaidTotal ?? sale.saleAmount
  if (
    orderTotal <= sale.saleAmount + 0.009 &&
    paidTotal <= sale.saleAmount + 0.009
  ) {
    return sale
  }
  return {
    ...sale,
    total: orderTotal,
    channelOrderTotal: orderTotal,
    channelPaidTotal: paidTotal,
    status: paidTotal + 0.009 < orderTotal ? "partial" : sale.status,
  }
}

function formatGroupedPaymentLabel(
  payments: OperationSaleRow["payments"],
): string {
  if (payments.length === 0) return "—"
  const fmt = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  })
  return payments
    .map((payment) => `${payment.methodName} ${fmt.format(payment.amount)}`)
    .join(" · ")
}
