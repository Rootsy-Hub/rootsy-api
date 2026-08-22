import type { SupabaseClient } from "@supabase/supabase-js"
import { parseChannelSaleMetadata } from "./channelSales.js"
import { CLIENT_IVA_CONDITION_OPTIONS } from "./iva.js"
import { operationPaymentKindLabel, resolveOperationPaymentMethodLabel } from "./paymentLabels.js"
import {
  purchaseComprobanteAccruesInputVat,
  saleComprobanteAccruesOutputVat,
  saleComprobanteLabel,
  saleHasComprobante,
} from "./saleInvoice.js"
import { parseLineDisplay, parseSnapshotTotals } from "./saleSnapshot.js"
import type {
  OperationExpenseLedgerRow,
  OperationPurchaseDiscountInfo,
  OperationPurchaseLineItem,
  OperationPurchasePayment,
  OperationPurchaseRow,
  OperationSaleArcaInvoice,
  OperationSaleChannel,
  OperationSaleChargeRow,
  OperationSaleDiscountInfo,
  OperationSaleLineItem,
  OperationSalePayment,
  OperationSaleQuantityDealSummary,
  OperationSaleRow,
  OperationSaleSnapshotInfo,
  OperationServiceChargePaymentRow,
  OperationServiceChargeRow,
} from "./schema.js"
import {
  billingPeriodDisplayForCharge,
  isServiceBillingPeriod,
  isServiceChargeBillingScope,
  isServiceDiscountMode,
  resolveServiceChargeEffectiveStatus,
  roundServiceChargeMoney,
  type ServiceBillingPeriod,
  type ServiceChargeBillingScope,
  type ServiceChargePaymentMode,
  type ServiceChargeStoredStatus,
  type ServiceDiscountMode,
} from "./serviceCharges.js"

export function parseMoney(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

export function relOne<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
}

function parseQty(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 1e6) / 1e6
}

function parsePromotionSnapshot(
  raw: unknown,
): OperationSaleLineItem["promotionSnapshot"] {
  if (raw == null || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const components = Array.isArray(o.components)
    ? o.components
        .filter((c): c is Record<string, unknown> => c != null && typeof c === "object")
        .map((c) => ({
          name_snapshot:
            typeof c.name_snapshot === "string" ? c.name_snapshot : undefined,
          quantity: c.quantity != null ? parseQty(c.quantity) : undefined,
          article_id: c.article_id != null ? String(c.article_id) : null,
          recipe_id: c.recipe_id != null ? String(c.recipe_id) : null,
          slot_id:
            typeof c.slot_id === "string" && c.slot_id.trim()
              ? c.slot_id.trim()
              : null,
        }))
    : undefined
  return {
    listTotal: o.list_total != null ? parseMoney(o.list_total) : undefined,
    promoDiscount:
      o.promo_discount != null ? parseMoney(o.promo_discount) : undefined,
    components,
  }
}

function parseLineItems(raw: unknown): OperationSaleLineItem[] {
  if (!Array.isArray(raw)) return []
  const out: OperationSaleLineItem[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") continue
    const o = row as Record<string, unknown>
    const discountRaw = o.discount_source
    const discountSource =
      discountRaw === "catalog" ||
      discountRaw === "manual" ||
      discountRaw === "quantity_deal" ||
      discountRaw === "combo" ||
      discountRaw === "none"
        ? discountRaw
        : null
    const lineKindRaw = o.line_kind
    const lineKind =
      lineKindRaw === "article" ||
      lineKindRaw === "recipe" ||
      lineKindRaw === "promotion"
        ? lineKindRaw
        : null
    out.push({
      articleId: o.article_id != null ? String(o.article_id) : null,
      recipeId: o.recipe_id != null ? String(o.recipe_id) : null,
      promotionId: o.promotion_id != null ? String(o.promotion_id) : null,
      lineKind,
      nameSnapshot: String(o.name_snapshot ?? "—"),
      quantity: parseQty(o.quantity),
      unitPrice: parseMoney(o.unit_price),
      lineTotal: parseMoney(o.line_total),
      iva: parseMoney(o.iva),
      lineDiscount: parseMoney(o.line_discount),
      itemDiscountMode:
        o.item_discount_mode === "porcentaje" || o.item_discount_mode === "fijo"
          ? o.item_discount_mode
          : null,
      itemDiscountValue:
        o.item_discount_value != null
          ? parseMoney(o.item_discount_value)
          : null,
      itemDiscountAmount: parseMoney(o.item_discount_amount),
      lineSubtotal:
        o.line_subtotal != null ? parseMoney(o.line_subtotal) : null,
      comment:
        typeof o.comment === "string" && o.comment.trim()
          ? o.comment.trim()
          : null,
      discountSource,
      promotionDealId:
        o.promotion_deal_id != null ? String(o.promotion_deal_id) : null,
      promotionDealName:
        typeof o.promotion_deal_name === "string" && o.promotion_deal_name.trim()
          ? o.promotion_deal_name.trim()
          : null,
      lineGroupId:
        typeof o.line_group_id === "string" && o.line_group_id.trim()
          ? o.line_group_id.trim()
          : null,
      listLineTotal:
        o.list_line_total != null ? parseMoney(o.list_line_total) : null,
      taxBase: o.tax_base != null ? parseMoney(o.tax_base) : null,
      taxAmount: o.tax_amount != null ? parseMoney(o.tax_amount) : null,
      generalDiscountShare:
        o.general_discount_share != null
          ? parseMoney(o.general_discount_share)
          : null,
      display: parseLineDisplay(o.display),
      promotionSnapshot: parsePromotionSnapshot(o.promotion_snapshot),
    })
  }
  return out
}

function parseBooleanMetadataFlag(metadata: unknown, key: string): boolean {
  if (metadata == null || typeof metadata !== "object") return false
  return (metadata as Record<string, unknown>)[key] === true
}

function parseCustomerIvaConditionLabel(
  metadata: unknown,
  customerName: string | null,
): string {
  if (metadata != null && typeof metadata === "object") {
    const raw = (metadata as Record<string, unknown>).customer_iva_condition
    if (typeof raw === "string" && raw.trim()) {
      const label = CLIENT_IVA_CONDITION_OPTIONS.find((o) => o.value === raw)
        ?.label
      return label ?? raw
    }
  }
  if (!customerName?.trim()) return "Consumidor final"
  return "—"
}

function parseSupplierIvaConditionLabel(ivaCondition: unknown): string {
  if (ivaCondition != null && String(ivaCondition).trim()) {
    const raw = String(ivaCondition).trim()
    const label = CLIENT_IVA_CONDITION_OPTIONS.find((o) => o.value === raw)
      ?.label
    return label ?? raw
  }
  return "—"
}

function parsePurchaseComprobanteInfo(
  metadata: unknown,
  documentKindFallback: string | null = null,
): {
  documentKindLabel: string | null
  accruesInputVat: boolean
  vatIncludedEstimate: number | null
} {
  let documentKind = documentKindFallback?.trim() || null
  if (!documentKind && metadata != null && typeof metadata === "object") {
    const raw = (metadata as Record<string, unknown>).purchase_document_kind
    if (typeof raw === "string" && raw.trim()) {
      documentKind = raw.trim()
    }
  }

  const accruesFromKind = purchaseComprobanteAccruesInputVat(documentKind)
  let accruesInputVat = accruesFromKind
  if (!documentKind && metadata != null && typeof metadata === "object") {
    const flag = (metadata as Record<string, unknown>).purchase_accrues_input_vat
    if (typeof flag === "boolean") {
      accruesInputVat = flag
    }
  }

  let vatIncludedEstimate: number | null = null
  if (metadata != null && typeof metadata === "object") {
    const estimate = Number(
      (metadata as Record<string, unknown>).vat_included_estimate,
    )
    if (Number.isFinite(estimate) && estimate > 0) {
      vatIncludedEstimate = parseMoney(estimate)
    }
  }

  return {
    documentKindLabel: documentKind,
    accruesInputVat,
    vatIncludedEstimate,
  }
}

function parseSaleMetadata(
  metadata: unknown,
  fiscalSiteId: string,
): { invoiceTypeLabel: string | null; accruesOutputVat: boolean } {
  if (metadata == null || typeof metadata !== "object") {
    return { invoiceTypeLabel: null, accruesOutputVat: false }
  }
  const o = metadata as Record<string, unknown>
  const rawLabel = o.invoice_type_label
  const invoiceTypeLabel =
    typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : null

  if (typeof o.invoice_accrues_output_vat === "boolean") {
    return { invoiceTypeLabel, accruesOutputVat: o.invoice_accrues_output_vat }
  }

  return {
    invoiceTypeLabel,
    accruesOutputVat: saleComprobanteAccruesOutputVat(
      fiscalSiteId,
      invoiceTypeLabel,
    ),
  }
}

function parseSaleDiscountInfo(metadata: unknown): OperationSaleDiscountInfo {
  const empty: OperationSaleDiscountInfo = {
    itemDiscountTotal: 0,
    generalDiscountAmount: 0,
    generalDiscountMode: null,
    generalDiscountValue: null,
    subtotalBeforeGeneralDiscount: null,
    quantityDealApplications: [],
  }
  if (metadata == null || typeof metadata !== "object") return empty
  const o = metadata as Record<string, unknown>
  const mode = o.general_discount_mode
  const qtyDealsRaw = o.quantity_deal_applications
  const quantityDealApplications: OperationSaleQuantityDealSummary[] = []
  if (Array.isArray(qtyDealsRaw)) {
    for (const row of qtyDealsRaw) {
      if (!row || typeof row !== "object") continue
      const d = row as Record<string, unknown>
      quantityDealApplications.push({
        promotionId: String(d.promotion_id ?? ""),
        promotionName: String(d.promotion_name ?? "Promoción"),
        discountAmount: parseMoney(d.discount_amount),
      })
    }
  }
  return {
    itemDiscountTotal: parseMoney(o.item_discount_total),
    generalDiscountAmount: parseMoney(o.general_discount_amount),
    generalDiscountMode:
      mode === "porcentaje" || mode === "fijo" ? mode : null,
    generalDiscountValue:
      o.general_discount_value != null
        ? parseMoney(o.general_discount_value)
        : null,
    subtotalBeforeGeneralDiscount:
      o.subtotal_before_general_discount != null
        ? parseMoney(o.subtotal_before_general_discount)
        : null,
    quantityDealApplications,
  }
}

function parseSaleSnapshotInfo(metadata: unknown): OperationSaleSnapshotInfo {
  if (metadata == null || typeof metadata !== "object") {
    return { version: null, totals: null }
  }
  const o = metadata as Record<string, unknown>
  const versionRaw = o.snapshot_version
  const version =
    versionRaw != null && Number.isFinite(Number(versionRaw))
      ? Number(versionRaw)
      : null
  return {
    version,
    totals: parseSnapshotTotals(o.totals),
  }
}

function parsePurchaseDiscountInfo(
  metadata: unknown,
): OperationPurchaseDiscountInfo {
  return parseSaleDiscountInfo(metadata)
}

function parsePurchaseLineItems(raw: unknown): OperationPurchaseLineItem[] {
  if (!Array.isArray(raw)) return []
  const out: OperationPurchaseLineItem[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") continue
    const o = row as Record<string, unknown>
    out.push({
      articleId: o.article_id != null ? String(o.article_id) : null,
      nameSnapshot: String(o.name_snapshot ?? "—"),
      quantity: parseQty(o.quantity),
      unitCost: parseMoney(o.unit_cost),
      lineTotal: parseMoney(o.line_total),
      iva: parseMoney(o.iva),
      itemDiscountMode:
        o.item_discount_mode === "porcentaje" || o.item_discount_mode === "fijo"
          ? o.item_discount_mode
          : null,
      itemDiscountValue:
        o.item_discount_value != null
          ? parseMoney(o.item_discount_value)
          : null,
      itemDiscountAmount: parseMoney(o.item_discount_amount),
      lineSubtotal:
        o.line_subtotal != null ? parseMoney(o.line_subtotal) : null,
      comment:
        typeof o.comment === "string" && o.comment.trim()
          ? o.comment.trim()
          : null,
    })
  }
  return out
}

export function parseServiceChargeMoney(v: unknown): number {
  return roundServiceChargeMoney(Number(v ?? 0) || 0)
}

export function mapOperationServiceChargeRow(
  row: Record<string, unknown>,
  paidByChargeId: Map<string, number>,
  paymentsByChargeId: Map<string, OperationServiceChargePaymentRow[]>,
  today: string,
): OperationServiceChargeRow {
  const client = row.clients as { name?: string } | null
  const service = row.service_types as {
    name?: string
    billing_period?: string
    billing_period_label?: string | null
  } | null
  const billingPeriodRaw = String(service?.billing_period ?? "monthly")
  const billingPeriod: ServiceBillingPeriod = isServiceBillingPeriod(
    billingPeriodRaw,
  )
    ? billingPeriodRaw
    : "monthly"
  const billingPeriodLabel =
    typeof service?.billing_period_label === "string" &&
    service.billing_period_label.trim()
      ? service.billing_period_label.trim()
      : null
  const amount = parseServiceChargeMoney(row.amount)
  const paidTotal = roundServiceChargeMoney(
    paidByChargeId.get(String(row.id)) ?? 0,
  )
  const unitPrice = parseServiceChargeMoney(row.unit_price)
  const discountMode = (
    isServiceDiscountMode(String(row.discount_mode ?? "none"))
      ? String(row.discount_mode)
      : "none"
  ) as ServiceDiscountMode
  const discountValue =
    row.discount_value == null || row.discount_value === ""
      ? null
      : parseServiceChargeMoney(row.discount_value)
  const cancelledAt =
    typeof row.cancelled_at === "string" ? row.cancelled_at : null
  const storedStatus = String(
    row.status ?? "pending",
  ) as ServiceChargeStoredStatus
  const dueDate = String(row.due_date ?? "")
  const sequenceIndex = Number(row.sequence_index ?? 0) || 0
  const periodCount = Number(row.period_count ?? 1) || 1
  const periodStart =
    typeof row.period_start === "string" ? row.period_start : null
  const periodEnd = typeof row.period_end === "string" ? row.period_end : null
  const billingScopeRaw = String(row.billing_scope ?? "one_period")
  const billingScope = isServiceChargeBillingScope(billingScopeRaw)
    ? billingScopeRaw
    : "one_period"

  return {
    id: String(row.id),
    createdAt: String(row.created_at ?? ""),
    dueDate,
    clientId: String(row.client_id),
    clientName: String(client?.name ?? "—"),
    serviceTypeId: String(row.service_type_id),
    serviceName: String(service?.name ?? "—"),
    billingPeriod,
    billingPeriodLabel,
    billingScope,
    paymentMode: (String(row.payment_mode ?? "one_time") === "subscription"
      ? "subscription"
      : "one_time") as ServiceChargePaymentMode,
    periodCount,
    sequenceIndex,
    periodStart,
    periodEnd,
    periodDisplay: billingPeriodDisplayForCharge(
      billingPeriod,
      billingPeriodLabel,
      periodStart,
      periodEnd,
      sequenceIndex,
      periodCount,
    ),
    unitPrice,
    discountMode,
    discountValue,
    discountAmount: roundServiceChargeMoney(Math.max(0, unitPrice - amount)),
    amount,
    paidTotal,
    balance: roundServiceChargeMoney(Math.max(0, amount - paidTotal)),
    storedStatus,
    effectiveStatus: resolveServiceChargeEffectiveStatus({
      storedStatus,
      cancelledAt,
      amount,
      paidTotal,
      dueDate,
      today,
    }),
    cancelledAt,
    notes: String(row.notes ?? ""),
    payments: paymentsByChargeId.get(String(row.id)) ?? [],
  }
}

export type TableSessionListSummary = {
  openedAt: string | null
  closedAt: string | null
  openedBy: string | null
  closedBy: string | null
  waiterUserId: string | null
}

export type CounterOrderListSummary = {
  openedAt: string | null
  status: string | null
  fulfillmentType: "pickup" | "delivery" | null
  openedBy: string | null
  deliveredAt: string | null
  cancelledAt: string | null
  cancelledBy: string | null
}

export function applyChannelListFieldsToSaleRows(
  sales: OperationSaleRow[],
  options: {
    view: "table" | "counter"
    tableSummaryBySessionId: Map<string, TableSessionListSummary>
    counterSummaryByOrderId: Map<string, CounterOrderListSummary>
    userNames: Map<string, string>
  },
): OperationSaleRow[] {
  const { view, tableSummaryBySessionId, counterSummaryByOrderId, userNames } =
    options

  return sales.map((sale) => {
    if (view === "table") {
      const sessionId = sale.tableSessionId?.trim() || ""
      if (!sessionId) return sale
      const summary = tableSummaryBySessionId.get(sessionId)
      if (!summary) return sale
      return {
        ...sale,
        channelOpenedAt: summary.openedAt,
        channelOpenedByName: summary.openedBy
          ? (userNames.get(summary.openedBy) ?? null)
          : null,
        channelClosedAt: summary.closedAt,
        channelClosedByName: summary.closedBy
          ? (userNames.get(summary.closedBy) ?? null)
          : null,
        channelWaiterName: summary.waiterUserId
          ? (userNames.get(summary.waiterUserId) ?? null)
          : null,
      }
    }

    const orderId = sale.counterOrderId?.trim() || ""
    if (!orderId) return sale
    const summary = counterSummaryByOrderId.get(orderId)
    if (!summary) return sale

    let channelClosedAt: string | null = null
    let channelClosedByName: string | null = null
    if (summary.status === "cancelled" && summary.cancelledAt) {
      channelClosedAt = summary.cancelledAt
      channelClosedByName = summary.cancelledBy
        ? (userNames.get(summary.cancelledBy) ?? null)
        : null
    } else if (summary.deliveredAt) {
      channelClosedAt = summary.deliveredAt
      channelClosedByName = sale.soldByName
    }

    return {
      ...sale,
      channelOpenedAt: summary.openedAt,
      channelOpenedByName: summary.openedBy
        ? (userNames.get(summary.openedBy) ?? null)
        : null,
      channelClosedAt,
      channelClosedByName,
      channelCounterStatus: summary.status,
      channelFulfillmentType: summary.fulfillmentType,
    }
  })
}

export function formatTreasuryPaymentLabel(p: {
  payment_kind?: unknown
  treasury_accounts?:
    | { name?: string }
    | Array<{ name?: string }>
    | null
}): string {
  const kind = p.payment_kind != null ? String(p.payment_kind).trim() : ""
  const ta = relOne(p.treasury_accounts)
  const taName = ta?.name?.trim() || ""
  const kindLabel = kind ? operationPaymentKindLabel(kind) : ""
  if (kindLabel && taName) return `${kindLabel} — ${taName}`
  return kindLabel || taName || "—"
}

export function resolveSaleChannelFromRow(
  row: Record<string, unknown>,
): OperationSaleChannel {
  const channel = String(row.sale_channel ?? "").trim()
  if (channel === "table" || channel === "counter" || channel === "pos") {
    return channel
  }
  if (row.table_session_id != null && String(row.table_session_id).trim()) {
    return "table"
  }
  if (row.counter_order_id != null && String(row.counter_order_id).trim()) {
    return "counter"
  }
  return "pos"
}

export function parseTableLabelFromSession(
  row: Record<string, unknown>,
  labelsBySessionId: Map<string, string>,
): string | null {
  const sessionId =
    row.table_session_id != null ? String(row.table_session_id).trim() : ""
  if (!sessionId) return null
  return labelsBySessionId.get(sessionId) ?? null
}

export function parseCounterOrderLabel(
  row: Record<string, unknown>,
  labelByOrderId: Map<string, string>,
): string | null {
  const orderId =
    row.counter_order_id != null ? String(row.counter_order_id).trim() : ""
  if (!orderId) return null
  return labelByOrderId.get(orderId) ?? null
}

export function mapSaleRows(
  saleRows: Array<Record<string, unknown>>,
  arcaBySaleId: Map<string, OperationSaleArcaInvoice>,
  fiscalSiteId: string,
  tableLabelBySessionId: Map<string, string> = new Map(),
  counterOrderLabelByOrderId: Map<string, string> = new Map(),
  userNames: Map<string, string> = new Map(),
): OperationSaleRow[] {
  return saleRows.map((row) => {
    const saleId = String(row.id)
    const paymentsRaw = row.sale_payments as
      | Array<{
          amount?: unknown
          sort_order?: unknown
          payment_kind?: unknown
          treasury_accounts?:
            | { name?: string }
            | Array<{ name?: string }>
            | null
        }>
      | null
    const payments: OperationSalePayment[] = []
    const payList = Array.isArray(paymentsRaw) ? [...paymentsRaw] : []
    payList.sort(
      (a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0),
    )
    for (const p of payList) {
      payments.push({
        amount: parseMoney(p.amount),
        methodName: formatTreasuryPaymentLabel(p),
      })
    }

    const saleMeta = parseSaleMetadata(row.metadata, fiscalSiteId)
    const channelMeta = parseChannelSaleMetadata(row.metadata)
    const rowTotal = parseMoney(row.total)
    const accruesOutputVat = saleMeta.accruesOutputVat
    const customerName =
      row.customer_name != null ? String(row.customer_name) : null
    const createdBy =
      row.created_by != null ? String(row.created_by).trim() || null : null

    return {
      id: saleId,
      soldAt: String(row.sold_at ?? ""),
      status: String(row.status ?? ""),
      saleAmount: rowTotal,
      total: rowTotal,
      subtotal: accruesOutputVat ? parseMoney(row.subtotal) : rowTotal,
      taxTotal: accruesOutputVat ? parseMoney(row.tax_total) : 0,
      discountTotal: parseMoney(row.discount_total),
      discountInfo: parseSaleDiscountInfo(row.metadata),
      snapshotInfo: parseSaleSnapshotInfo(row.metadata),
      clientId: row.client_id != null ? String(row.client_id) : null,
      customerName,
      customerTaxId:
        row.customer_tax_id != null ? String(row.customer_tax_id) : null,
      customerIvaConditionLabel: parseCustomerIvaConditionLabel(
        row.metadata,
        customerName,
      ),
      soldByName: createdBy ? userNames.get(createdBy) ?? null : null,
      invoiceTypeLabel: saleMeta.invoiceTypeLabel,
      accruesOutputVat,
      arcaInvoice: arcaBySaleId.get(saleId) ?? null,
      currency: String(row.currency ?? "ARS"),
      lineItems: parseLineItems(row.line_items),
      payments,
      paymentMethodLabel: resolveOperationPaymentMethodLabel({
        payments,
        onClientAccount:
          parseBooleanMetadataFlag(row.metadata, "pay_on_client_account") ||
          (payments.length === 0 &&
            row.client_id != null &&
            String(row.status ?? "") === "completed"),
      }),
      tableLabel: parseTableLabelFromSession(row, tableLabelBySessionId),
      counterOrderLabel: parseCounterOrderLabel(row, counterOrderLabelByOrderId),
      saleChannel: resolveSaleChannelFromRow(row),
      tableSessionId:
        row.table_session_id != null ? String(row.table_session_id) : null,
      counterOrderId:
        row.counter_order_id != null ? String(row.counter_order_id) : null,
      channelOrderTotal: channelMeta.channelOrderTotal,
      channelPaidTotal: channelMeta.channelPaidAccumulated,
    }
  })
}

export function mapPurchaseRows(
  purchaseRows: Array<Record<string, unknown>>,
  userNames: Map<string, string> = new Map(),
  documentKindByPurchaseId: Map<string, string> = new Map(),
): OperationPurchaseRow[] {
  return purchaseRows.map((row) => {
    const sup = row.suppliers as { name?: string; iva_condition?: unknown } | null
    const supplierId = row.supplier_id != null ? String(row.supplier_id) : null
    const rawSupplierName =
      sup?.name?.trim() ||
      (row.supplier_name != null ? String(row.supplier_name).trim() : "")
    const supplierName = rawSupplierName || "—"
    const receivedAt = row.received_at != null ? String(row.received_at) : ""
    const documentDate =
      row.document_date != null ? String(row.document_date) : ""
    const createdAt = String(row.created_at ?? "")
    const createdBy =
      row.created_by != null ? String(row.created_by).trim() || null : null
    const operationDate =
      receivedAt.slice(0, 10) ||
      documentDate.slice(0, 10) ||
      createdAt.slice(0, 10)
    const operationAt =
      receivedAt ||
      createdAt ||
      (operationDate ? `${operationDate}T00:00:00` : "")

    const paymentsRaw = row.purchase_payments as
      | Array<{
          amount?: unknown
          paid_at?: unknown
          payment_kind?: unknown
          treasury_accounts?:
            | { name?: string }
            | Array<{ name?: string }>
            | null
        }>
      | null
    const payments: OperationPurchasePayment[] = []
    const payList = Array.isArray(paymentsRaw) ? [...paymentsRaw] : []
    payList.sort((a, b) =>
      String(a.paid_at ?? "").localeCompare(String(b.paid_at ?? "")),
    )
    let paidTotal = 0
    for (const p of payList) {
      const amt = parseMoney(p.amount)
      paidTotal = Math.round((paidTotal + amt) * 100) / 100
      payments.push({
        amount: amt,
        methodName: formatTreasuryPaymentLabel(p),
        paidAt: String(p.paid_at ?? "").slice(0, 10),
      })
    }

    const purchaseId = String(row.id)
    const comprobante = parsePurchaseComprobanteInfo(
      row.metadata,
      documentKindByPurchaseId.get(purchaseId) ?? null,
    )

    return {
      id: purchaseId,
      operationDate,
      operationAt,
      status: String(row.status ?? ""),
      purchaseKind: String(row.purchase_kind ?? "merchandise"),
      subtotal: parseMoney(row.subtotal),
      total: parseMoney(row.total),
      taxTotal: parseMoney(row.tax_total),
      paidTotal,
      supplierId,
      supplierName,
      documentNumber:
        row.document_number != null ? String(row.document_number) : null,
      currency: String(row.currency ?? "ARS"),
      discountTotal: parseMoney(row.discount_total),
      discountInfo: parsePurchaseDiscountInfo(row.metadata),
      lineItems: parsePurchaseLineItems(row.line_items),
      payments,
      paymentMethodLabel: resolveOperationPaymentMethodLabel({
        payments,
        onSupplierAccount:
          parseBooleanMetadataFlag(row.metadata, "pay_on_supplier_account") ||
          (payments.length === 0 &&
            supplierId != null &&
            !["paid", "cancelled", "voided", "draft"].includes(
              String(row.status ?? ""),
            )),
      }),
      purchasedByName: createdBy ? userNames.get(createdBy) ?? null : null,
      documentKindLabel: comprobante.documentKindLabel,
      accruesInputVat: comprobante.accruesInputVat,
      supplierIvaConditionLabel: parseSupplierIvaConditionLabel(
        sup?.iva_condition,
      ),
      vatIncludedEstimate: comprobante.vatIncludedEstimate,
    }
  })
}

export async function mapExpenseLedgerRows(
  supabase: SupabaseClient,
  popId: string,
  aeList: Array<Record<string, unknown>>,
  userNames: Map<string, string> = new Map(),
): Promise<OperationExpenseLedgerRow[]> {
  const payIds = aeList
    .map((r) => (r.source_id != null ? String(r.source_id) : ""))
    .filter((id) => id.length > 0)

  type PaymentJoin = {
    id: string
    amount: unknown
    paid_at: unknown
    expense_id: unknown
    payment_kind?: unknown
    treasury_accounts?: { name?: string } | null
    expenses: {
      id?: string
      amount?: unknown
      description?: string | null
      expense_categories: { name?: string } | null
    } | null
  }

  const paymentById = new Map<string, PaymentJoin>()
  if (payIds.length > 0) {
    const { data: epRows } = await supabase
      .from("expense_payments")
      .select(
        `
          id,
          amount,
          paid_at,
          expense_id,
          payment_kind,
          treasury_accounts ( name ),
          expenses (
            id,
            amount,
            description,
            expense_categories ( name )
          )
        `,
      )
      .eq("pop_id", popId)
      .in("id", payIds)
    for (const raw of epRows || []) {
      const row = raw as Record<string, unknown>
      const expenseRaw = relOne(
        row.expenses as
          | {
              id?: string
              amount?: unknown
              description?: string | null
              expense_categories?:
                | { name?: string }
                | Array<{ name?: string }>
                | null
            }
          | Array<{
              id?: string
              amount?: unknown
              description?: string | null
              expense_categories?:
                | { name?: string }
                | Array<{ name?: string }>
                | null
            }>
          | null
          | undefined,
      )
      const category = expenseRaw
        ? relOne(expenseRaw.expense_categories)
        : null
      paymentById.set(String(row.id), {
        id: String(row.id),
        amount: row.amount,
        paid_at: row.paid_at,
        expense_id: row.expense_id,
        payment_kind: row.payment_kind,
        treasury_accounts: relOne(
          row.treasury_accounts as
            | { name?: string }
            | Array<{ name?: string }>
            | null
            | undefined,
        ),
        expenses: expenseRaw
          ? {
              id: expenseRaw.id,
              amount: expenseRaw.amount,
              description: expenseRaw.description,
              expense_categories: category,
            }
          : null,
      })
    }
  }

  return aeList.map((row) => {
    const sid = row.source_id != null ? String(row.source_id) : ""
    const src = String(row.source_type ?? "")
    const isVoid = src === "expense_void"
    const entryDate = String(row.entry_date ?? "").slice(0, 10)
    const postedAt = row.posted_at != null ? String(row.posted_at) : ""
    const createdAt = row.created_at != null ? String(row.created_at) : ""
    const payment = paymentById.get(sid)
    const expense = payment?.expenses
    const categoryName =
      expense?.expense_categories?.name?.trim() ||
      String(row.description ?? "").replace(/^Gasto — /, "").split(" — ")[0]
        ?.trim() ||
      "—"
    const expenseDesc = expense?.description?.trim() || ""
    const ledgerDesc = String(row.description ?? "").trim()
    const description =
      expenseDesc ||
      ledgerDesc.replace(/^Anulación — /, "").replace(/^Gasto — /, "") ||
      "—"
    const paidAt =
      payment?.paid_at != null ? String(payment.paid_at).slice(0, 10) : ""
    const operationAt =
      postedAt ||
      createdAt ||
      (paidAt ? `${paidAt}T12:00:00` : "") ||
      (entryDate ? `${entryDate}T00:00:00` : "")
    const operationDate = paidAt || entryDate || operationAt.slice(0, 10)
    const amount = parseMoney(payment?.amount)
    const expenseAmount =
      expense?.amount != null ? parseMoney(expense.amount) : null
    const paymentMethodLabel = isVoid
      ? "—"
      : formatTreasuryPaymentLabel({
          payment_kind: payment?.payment_kind,
          treasury_accounts: payment?.treasury_accounts,
        })

    const createdBy =
      row.created_by != null ? String(row.created_by).trim() || null : null

    return {
      entryId: String(row.id),
      expenseId:
        expense?.id != null
          ? String(expense.id)
          : payment?.expense_id != null
            ? String(payment.expense_id)
            : null,
      expensePaymentId: sid || null,
      sourceType: isVoid ? "expense_void" : "expense_payment",
      operationDate,
      operationAt,
      amount,
      expenseAmount,
      categoryName,
      description,
      paymentMethodLabel,
      recordedByName: createdBy ? userNames.get(createdBy) ?? null : null,
    }
  })
}

export function mapSaleToChargeRow(
  sale: OperationSaleRow,
): OperationSaleChargeRow {
  const label = saleComprobanteLabel(sale)
  return {
    saleId: sale.id,
    soldAt: sale.soldAt,
    amount: sale.saleAmount,
    methodName: sale.paymentMethodLabel,
    comprobanteLabel: label !== "—" ? label : null,
    hasComprobante: saleHasComprobante(sale),
    sale,
  }
}
