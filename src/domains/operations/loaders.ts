import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney } from "./mappers.js"
import type { CounterOrderListSummary, TableSessionListSummary } from "./mappers.js"
import { findSaleInvoiceTypeByArcaCbteTipo } from "./saleInvoice.js"
import type { OperationSaleArcaInvoice } from "./schema.js"

const SALE_LIST_COLUMNS = `
        id,
        sold_at,
        status,
        total,
        subtotal,
        tax_total,
        discount_total,
        client_id,
        customer_name,
        customer_tax_id,
        metadata,
        currency,
        table_session_id,
        counter_order_id,
        sale_channel,
        created_by,
        sale_payments (
          amount,
          sort_order,
          payment_kind,
          treasury_account_id,
          treasury_accounts ( name )
        )
`

const PURCHASE_LIST_COLUMNS = `
        id,
        purchase_kind,
        status,
        document_number,
        document_date,
        supplier_id,
        supplier_name,
        subtotal,
        total,
        tax_total,
        discount_total,
        currency,
        metadata,
        created_at,
        created_by,
        received_at,
        suppliers ( name, iva_condition ),
        purchase_payments (
          amount,
          paid_at,
          payment_kind,
          treasury_account_id,
          treasury_accounts ( name )
        )
`

/** Sin line_items: alcanza para la tabla. El detalle pide el full. */
export const SALE_LIST_SELECT = SALE_LIST_COLUMNS

export const SALE_DETAIL_SELECT = `
        ${SALE_LIST_COLUMNS},
        line_items
`

export const PURCHASE_LIST_SELECT = PURCHASE_LIST_COLUMNS

export const PURCHASE_DETAIL_SELECT = `
        ${PURCHASE_LIST_COLUMNS},
        line_items
`

export function saleRowsSelect(includeLines: boolean): string {
  return includeLines ? SALE_DETAIL_SELECT : SALE_LIST_SELECT
}

export function purchaseRowsSelect(includeLines: boolean): string {
  return includeLines ? PURCHASE_DETAIL_SELECT : PURCHASE_LIST_SELECT
}

const FISCAL_RECEIVED_PURCHASE_DOC_KINDS = ["Factura A", "Factura B"] as const

export async function loadFiscalPurchaseIdsForPop(
  supabase: SupabaseClient,
  popId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("purchase_documents")
    .select("purchase_id")
    .eq("pop_id", popId)
    .in("doc_kind", [...FISCAL_RECEIVED_PURCHASE_DOC_KINDS])

  if (error || !data?.length) return []

  return [
    ...new Set(
      data
        .map((row) =>
          row.purchase_id != null ? String(row.purchase_id).trim() : "",
        )
        .filter(Boolean),
    ),
  ]
}

export async function loadArcaBySaleIds(
  supabase: SupabaseClient,
  popId: string,
  fiscalSiteId: string,
  saleIds: string[],
): Promise<Map<string, OperationSaleArcaInvoice>> {
  const arcaBySaleId = new Map<string, OperationSaleArcaInvoice>()
  if (saleIds.length === 0) return arcaBySaleId

  const { data: invRows } = await supabase
    .from("invoices_arca")
    .select(
      `
          id,
          sale_id,
          arca_cbte_tipo,
          arca_regimen,
          pto_vta,
          cbte_nro,
          cbte_fch,
          doc_tipo,
          doc_nro,
          receptor_razon_social,
          imp_total,
          imp_neto,
          imp_iva,
          cae,
          cae_fch_vto,
          status
        `,
    )
    .eq("pop_id", popId)
    .in("sale_id", saleIds)
    .order("created_at", { ascending: false })

  for (const row of invRows || []) {
    const sid = row.sale_id != null ? String(row.sale_id) : ""
    if (!sid || arcaBySaleId.has(sid)) continue
    const cbteTipo = Number(row.arca_cbte_tipo ?? 0)
    const opt = findSaleInvoiceTypeByArcaCbteTipo(fiscalSiteId, cbteTipo)
    const nro = row.cbte_nro
    arcaBySaleId.set(sid, {
      id: String(row.id),
      tipoLabel: opt?.label ?? `CbteTipo ${cbteTipo}`,
      arcaCbteTipo: cbteTipo,
      arcaRegimen: String(row.arca_regimen ?? "fe_general"),
      ptoVta: Number(row.pto_vta ?? 0),
      cbteNro:
        typeof nro === "bigint" || typeof nro === "number"
          ? String(nro)
          : String(nro ?? ""),
      cbteFch: String(row.cbte_fch ?? ""),
      docTipo: row.doc_tipo != null ? Number(row.doc_tipo) : null,
      docNro: String(row.doc_nro ?? ""),
      receptorRazonSocial: String(row.receptor_razon_social ?? ""),
      impTotal: parseMoney(row.imp_total),
      impNeto: parseMoney(row.imp_neto),
      impIva: parseMoney(row.imp_iva),
      cae: row.cae != null ? String(row.cae) : null,
      caeFchVto: row.cae_fch_vto != null ? String(row.cae_fch_vto) : null,
      status: String(row.status ?? ""),
    })
  }
  return arcaBySaleId
}

export async function loadTableLabelsBySessionIds(
  supabase: SupabaseClient,
  popId: string,
  sessionIds: string[],
): Promise<Map<string, string>> {
  const labelsBySessionId = new Map<string, string>()
  if (sessionIds.length === 0) return labelsBySessionId

  const { data: sessions, error } = await supabase
    .from("table_sessions")
    .select("id, dining_table_id, table_session_tables ( dining_table_id )")
    .eq("pop_id", popId)
    .in("id", sessionIds)

  if (error || !sessions?.length) return labelsBySessionId

  const tableIds = new Set<string>()
  for (const session of sessions) {
    if (session.dining_table_id) {
      tableIds.add(String(session.dining_table_id))
    }
    const extras = session.table_session_tables as
      | Array<{ dining_table_id?: string }>
      | null
    for (const row of extras ?? []) {
      if (row.dining_table_id) tableIds.add(String(row.dining_table_id))
    }
  }

  if (tableIds.size === 0) return labelsBySessionId

  const { data: tables } = await supabase
    .from("dining_tables")
    .select("id, label")
    .eq("pop_id", popId)
    .in("id", [...tableIds])

  const labelByTableId = new Map<string, string>()
  for (const table of tables ?? []) {
    const label = typeof table.label === "string" ? table.label.trim() : ""
    if (label) labelByTableId.set(String(table.id), label)
  }

  for (const session of sessions) {
    const orderedTableIds = [String(session.dining_table_id)]
    const extras = session.table_session_tables as
      | Array<{ dining_table_id?: string }>
      | null
    for (const row of extras ?? []) {
      const tableId = row.dining_table_id ? String(row.dining_table_id) : ""
      if (tableId && !orderedTableIds.includes(tableId)) {
        orderedTableIds.push(tableId)
      }
    }
    const labels = orderedTableIds
      .map((tableId) => labelByTableId.get(tableId))
      .filter((label): label is string => Boolean(label))
    if (labels.length > 0) {
      labelsBySessionId.set(String(session.id), labels.join(" + "))
    }
  }

  return labelsBySessionId
}

export async function loadTableLabelsBySaleIds(
  supabase: SupabaseClient,
  popId: string,
  saleRows: Array<Record<string, unknown>>,
): Promise<Map<string, string>> {
  const sessionIds = [
    ...new Set(
      saleRows
        .map((row) =>
          row.table_session_id != null ? String(row.table_session_id) : "",
        )
        .filter(Boolean),
    ),
  ]
  return loadTableLabelsBySessionIds(supabase, popId, sessionIds)
}

export async function loadCounterOrderLabelsByOrderIds(
  supabase: SupabaseClient,
  popId: string,
  orderIds: string[],
): Promise<Map<string, string>> {
  const labelByOrderId = new Map<string, string>()
  if (orderIds.length === 0) return labelByOrderId

  const { data, error } = await supabase
    .from("counter_orders")
    .select("id, order_number")
    .eq("pop_id", popId)
    .in("id", orderIds)

  if (error || !data?.length) return labelByOrderId

  for (const row of data) {
    const orderNumber = Number(row.order_number)
    if (!Number.isFinite(orderNumber)) continue
    labelByOrderId.set(String(row.id), `#${orderNumber}`)
  }

  return labelByOrderId
}

export async function loadCounterOrderLabelsBySaleIds(
  supabase: SupabaseClient,
  popId: string,
  saleRows: Array<Record<string, unknown>>,
): Promise<Map<string, string>> {
  const orderIds = [
    ...new Set(
      saleRows
        .map((row) =>
          row.counter_order_id != null ? String(row.counter_order_id) : "",
        )
        .filter(Boolean),
    ),
  ]
  return loadCounterOrderLabelsByOrderIds(supabase, popId, orderIds)
}

export async function loadTableSessionSummariesBySessionIds(
  supabase: SupabaseClient,
  popId: string,
  sessionIds: string[],
): Promise<Map<string, TableSessionListSummary>> {
  const summaryBySessionId = new Map<string, TableSessionListSummary>()
  if (sessionIds.length === 0) return summaryBySessionId

  const { data, error } = await supabase
    .from("table_sessions")
    .select("id, opened_at, closed_at, opened_by, closed_by, waiter_user_id")
    .eq("pop_id", popId)
    .in("id", sessionIds)

  if (error || !data?.length) return summaryBySessionId

  for (const row of data) {
    summaryBySessionId.set(String(row.id), {
      openedAt: row.opened_at != null ? String(row.opened_at) : null,
      closedAt: row.closed_at != null ? String(row.closed_at) : null,
      openedBy:
        row.opened_by != null ? String(row.opened_by).trim() || null : null,
      closedBy:
        row.closed_by != null ? String(row.closed_by).trim() || null : null,
      waiterUserId:
        row.waiter_user_id != null
          ? String(row.waiter_user_id).trim() || null
          : null,
    })
  }

  return summaryBySessionId
}

export async function loadTableSessionSummariesBySaleIds(
  supabase: SupabaseClient,
  popId: string,
  saleRows: Array<Record<string, unknown>>,
): Promise<Map<string, TableSessionListSummary>> {
  const sessionIds = [
    ...new Set(
      saleRows
        .map((row) =>
          row.table_session_id != null ? String(row.table_session_id) : "",
        )
        .filter(Boolean),
    ),
  ]
  return loadTableSessionSummariesBySessionIds(supabase, popId, sessionIds)
}

export async function loadCounterOrderSummariesByOrderIds(
  supabase: SupabaseClient,
  popId: string,
  orderIds: string[],
): Promise<Map<string, CounterOrderListSummary>> {
  const summaryByOrderId = new Map<string, CounterOrderListSummary>()
  if (orderIds.length === 0) return summaryByOrderId

  const { data, error } = await supabase
    .from("counter_orders")
    .select(
      "id, status, fulfillment_type, opened_at, delivered_at, cancelled_at, opened_by, cancelled_by",
    )
    .eq("pop_id", popId)
    .in("id", orderIds)

  if (error || !data?.length) return summaryByOrderId

  for (const row of data) {
    const fulfillment = String(row.fulfillment_type ?? "").trim()
    summaryByOrderId.set(String(row.id), {
      openedAt: row.opened_at != null ? String(row.opened_at) : null,
      status: row.status != null ? String(row.status) : null,
      fulfillmentType:
        fulfillment === "delivery" || fulfillment === "pickup"
          ? fulfillment
          : null,
      openedBy:
        row.opened_by != null ? String(row.opened_by).trim() || null : null,
      deliveredAt: row.delivered_at != null ? String(row.delivered_at) : null,
      cancelledAt: row.cancelled_at != null ? String(row.cancelled_at) : null,
      cancelledBy:
        row.cancelled_by != null
          ? String(row.cancelled_by).trim() || null
          : null,
    })
  }

  return summaryByOrderId
}

export async function loadCounterOrderSummariesBySaleIds(
  supabase: SupabaseClient,
  popId: string,
  saleRows: Array<Record<string, unknown>>,
): Promise<Map<string, CounterOrderListSummary>> {
  const orderIds = [
    ...new Set(
      saleRows
        .map((row) =>
          row.counter_order_id != null ? String(row.counter_order_id) : "",
        )
        .filter(Boolean),
    ),
  ]
  return loadCounterOrderSummariesByOrderIds(supabase, popId, orderIds)
}

export async function loadPurchaseDocumentKindsByPurchaseIds(
  supabase: SupabaseClient,
  popId: string,
  purchaseIds: string[],
): Promise<Map<string, string>> {
  const kindByPurchaseId = new Map<string, string>()
  if (purchaseIds.length === 0) return kindByPurchaseId

  const { data, error } = await supabase
    .from("purchase_documents")
    .select("purchase_id, doc_kind")
    .eq("pop_id", popId)
    .in("purchase_id", purchaseIds)
    .order("created_at", { ascending: false })

  if (error || !data?.length) return kindByPurchaseId

  for (const row of data) {
    const purchaseId =
      row.purchase_id != null ? String(row.purchase_id).trim() : ""
    const docKind = row.doc_kind != null ? String(row.doc_kind).trim() : ""
    if (!purchaseId || !docKind || kindByPurchaseId.has(purchaseId)) continue
    kindByPurchaseId.set(purchaseId, docKind)
  }

  return kindByPurchaseId
}

export async function loadUserDisplayNames(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))]
  const map = new Map<string, string>()
  if (unique.length === 0) return map

  const { data } = await supabase
    .from("users")
    .select("id, first_name, last_name")
    .in("id", unique)

  for (const row of data || []) {
    const name =
      `${String(row.first_name ?? "").trim()} ${String(row.last_name ?? "").trim()}`.trim()
    map.set(String(row.id), name || "Usuario")
  }

  return map
}
