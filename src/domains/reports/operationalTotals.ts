import type { SupabaseClient } from "@supabase/supabase-js"
import { loadFiscalPurchaseIdsForPop } from "../operations/loaders.js"
import {
  DEFAULT_OPERATIONAL_DAY_CLOSE_TIME,
  expandCalendarBoundsForOperationalFetch,
  filterSalesByOperationalPeriod,
  loadPopOperationalContext,
  usesOperationalDayFilter,
} from "../operations/operationalDay.js"
import {
  localDateExclusiveEndTimestamp,
  localDateStartTimestamp,
} from "../operations/timezone.js"
import { parseMoney, roundMoney } from "./money.js"
import type { OperationalTotalKind, OperationalTotalsData } from "./schema.js"

const SLIM_PAGE = 1000

function dateTimeStart(isoDate: string, timeZone: string): string {
  return localDateStartTimestamp(timeZone, isoDate)
}

function dateTimeExclusiveEnd(isoDate: string, timeZone: string): string {
  return localDateExclusiveEndTimestamp(timeZone, isoDate)
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function appendSalesDateFilter<
  Q extends {
    gte: (col: string, val: string) => Q
    lt: (col: string, val: string) => Q
  },
>(q: Q, dateFrom: string | null, dateTo: string | null, timeZone: string): Q {
  let x = q
  if (dateFrom) x = x.gte("sold_at", dateTimeStart(dateFrom, timeZone))
  if (dateTo) x = x.lt("sold_at", dateTimeExclusiveEnd(dateTo, timeZone))
  return x
}

function appendPurchasesDateFilter<Q extends { or: (s: string) => Q }>(
  q: Q,
  dateFrom: string | null,
  dateTo: string | null,
  timeZone: string,
): Q {
  if (!dateFrom && !dateTo) return q
  const start = dateFrom
    ? quotePostgrestValue(dateTimeStart(dateFrom, timeZone))
    : null
  const end = dateTo
    ? quotePostgrestValue(dateTimeExclusiveEnd(dateTo, timeZone))
    : null

  const receivedParts: string[] = ["received_at.not.is.null"]
  if (start) receivedParts.push(`received_at.gte.${start}`)
  if (end) receivedParts.push(`received_at.lt.${end}`)

  const documentParts: string[] = [
    "received_at.is.null",
    "document_date.not.is.null",
  ]
  if (dateFrom) documentParts.push(`document_date.gte.${dateFrom}`)
  if (dateTo) documentParts.push(`document_date.lte.${dateTo}`)

  const createdParts: string[] = ["received_at.is.null", "document_date.is.null"]
  if (start) createdParts.push(`created_at.gte.${start}`)
  if (end) createdParts.push(`created_at.lt.${end}`)

  return q.or(
    `and(${receivedParts.join(",")}),` +
      `and(${documentParts.join(",")}),` +
      `and(${createdParts.join(",")})`,
  )
}

function appendExpensesDateFilter<
  Q extends {
    gte: (col: string, val: string) => Q
    lte: (col: string, val: string) => Q
  },
>(q: Q, dateFrom: string | null, dateTo: string | null): Q {
  let x = q
  if (dateFrom) x = x.gte("entry_date", dateFrom)
  if (dateTo) x = x.lte("entry_date", dateTo)
  return x
}

function saleCollected(total: number, payments: number[]): number {
  if (payments.length > 0) {
    return roundMoney(payments.reduce((a, n) => a + n, 0))
  }
  return total
}

function purchasePaid(total: number, payments: number[]): number {
  if (payments.length > 0) {
    return roundMoney(payments.reduce((a, n) => a + n, 0))
  }
  return total
}

async function sumSalesTotals(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  from: string | null,
  to: string | null,
): Promise<
  { success: true; data: OperationalTotalsData } | { success: false; error: string }
> {
  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const useOperationalDay = usesOperationalDayFilter(
    operational.operationalDayCloseTime,
    from,
    to,
  )
  const fetchBounds = useOperationalDay
    ? expandCalendarBoundsForOperationalFetch(from, to)
    : { from, to }
  const timeZone = operational.timeZone
  const closeTime = useOperationalDay
    ? operational.operationalDayCloseTime
    : DEFAULT_OPERATIONAL_DAY_CLOSE_TIME

  if (!useOperationalDay) {
    let countQuery = supabase
      .from("sales")
      .select("id", { count: "exact", head: true })
      .eq("pop_id", popId)
    countQuery = appendSalesDateFilter(countQuery, from, to, timeZone)
    const { count, error: countErr } = await countQuery
    if (countErr) {
      return {
        success: false,
        error: countErr.message || "No se pudieron contar las ventas.",
      }
    }

    let total = 0
    let offset = 0
    while (true) {
      let q = supabase
        .from("sales")
        .select("total, sale_payments ( amount )")
        .eq("pop_id", popId)
        .range(offset, offset + SLIM_PAGE - 1)
      q = appendSalesDateFilter(q, from, to, timeZone)
      const { data, error } = await q
      if (error) {
        return {
          success: false,
          error: error.message || "No se pudieron sumar las ventas.",
        }
      }
      const rows = data || []
      for (const row of rows) {
        const payments = Array.isArray(row.sale_payments)
          ? row.sale_payments.map((p) => parseMoney(p.amount))
          : []
        total += saleCollected(parseMoney(row.total), payments)
      }
      if (rows.length < SLIM_PAGE) break
      offset += SLIM_PAGE
      if (offset > 200_000) break
    }

    return {
      success: true,
      data: {
        kind: "sales",
        count: count ?? 0,
        total: roundMoney(total),
        iva: null,
      },
    }
  }

  const rows: Array<{ soldAt: string; total: number; payments: number[] }> = []
  let offset = 0
  while (true) {
    let q = supabase
      .from("sales")
      .select("sold_at, total, sale_payments ( amount )")
      .eq("pop_id", popId)
      .range(offset, offset + SLIM_PAGE - 1)
    q = appendSalesDateFilter(q, fetchBounds.from, fetchBounds.to, timeZone)
    const { data, error } = await q
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudieron sumar las ventas.",
      }
    }
    const chunk = data || []
    for (const row of chunk) {
      rows.push({
        soldAt: String(row.sold_at ?? ""),
        total: parseMoney(row.total),
        payments: Array.isArray(row.sale_payments)
          ? row.sale_payments.map((p) => parseMoney(p.amount))
          : [],
      })
    }
    if (chunk.length < SLIM_PAGE) break
    offset += SLIM_PAGE
    if (offset > 200_000) break
  }

  const inPeriod = filterSalesByOperationalPeriod(
    rows,
    from,
    to,
    timeZone,
    closeTime,
  )
  const total = roundMoney(
    inPeriod.reduce(
      (acc, row) => acc + saleCollected(row.total, row.payments),
      0,
    ),
  )
  return {
    success: true,
    data: {
      kind: "sales",
      count: inPeriod.length,
      total,
      iva: null,
    },
  }
}

async function sumPurchasesTotals(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  from: string | null,
  to: string | null,
  fiscalOnly: boolean,
): Promise<
  { success: true; data: OperationalTotalsData } | { success: false; error: string }
> {
  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const timeZone = operational.timeZone

  let fiscalPurchaseIds: string[] | null = null
  if (fiscalOnly) {
    fiscalPurchaseIds = await loadFiscalPurchaseIdsForPop(supabase, popId)
    if (fiscalPurchaseIds.length === 0) {
      return {
        success: true,
        data: {
          kind: fiscalOnly ? "received-invoices" : "purchases",
          count: 0,
          total: 0,
          iva: fiscalOnly ? 0 : null,
        },
      }
    }
  }

  let countQuery = supabase
    .from("purchases")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .neq("status", "draft")
  if (fiscalPurchaseIds) countQuery = countQuery.in("id", fiscalPurchaseIds)
  countQuery = appendPurchasesDateFilter(countQuery, from, to, timeZone)
  const { count, error: countErr } = await countQuery
  if (countErr) {
    return {
      success: false,
      error: countErr.message || "No se pudieron contar las compras.",
    }
  }

  let total = 0
  let iva = 0
  let offset = 0
  while (true) {
    let q = supabase
      .from("purchases")
      .select("total, tax_total, subtotal, purchase_payments ( amount )")
      .eq("pop_id", popId)
      .neq("status", "draft")
      .range(offset, offset + SLIM_PAGE - 1)
    if (fiscalPurchaseIds) q = q.in("id", fiscalPurchaseIds)
    q = appendPurchasesDateFilter(q, from, to, timeZone)
    const { data, error } = await q
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudieron sumar las compras.",
      }
    }
    const rows = data || []
    for (const row of rows) {
      const payments = Array.isArray(row.purchase_payments)
        ? row.purchase_payments.map((p) => parseMoney(p.amount))
        : []
      const rowTotal = parseMoney(row.total)
      total += fiscalOnly ? rowTotal : purchasePaid(rowTotal, payments)
      if (fiscalOnly) {
        const tax = parseMoney(row.tax_total)
        if (tax > 0) {
          iva += tax
        } else {
          const diff = roundMoney(rowTotal - parseMoney(row.subtotal))
          if (diff > 0) iva += diff
        }
      }
    }
    if (rows.length < SLIM_PAGE) break
    offset += SLIM_PAGE
    if (offset > 200_000) break
  }

  return {
    success: true,
    data: {
      kind: fiscalOnly ? "received-invoices" : "purchases",
      count: count ?? 0,
      total: roundMoney(total),
      iva: fiscalOnly ? roundMoney(iva) : null,
    },
  }
}

async function sumExpensesTotals(
  supabase: SupabaseClient,
  popId: string,
  from: string | null,
  to: string | null,
): Promise<
  { success: true; data: OperationalTotalsData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("accounting_entries")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .in("source_type", ["expense_payment", "expense_void"])
    .eq("status", "posted")
  countQuery = appendExpensesDateFilter(countQuery, from, to)
  const { count, error: countErr } = await countQuery
  if (countErr) {
    return {
      success: false,
      error: countErr.message || "No se pudieron contar los gastos.",
    }
  }

  let idsQuery = supabase
    .from("accounting_entries")
    .select("source_id")
    .eq("pop_id", popId)
    .in("source_type", ["expense_payment", "expense_void"])
    .eq("status", "posted")
  idsQuery = appendExpensesDateFilter(idsQuery, from, to)
  const { data: entries, error: idsErr } = await idsQuery
  if (idsErr) {
    return {
      success: false,
      error: idsErr.message || "No se pudieron listar los gastos.",
    }
  }

  const paymentIds = [
    ...new Set(
      (entries || [])
        .map((row) => (row.source_id != null ? String(row.source_id) : ""))
        .filter(Boolean),
    ),
  ]

  let total = 0
  for (let i = 0; i < paymentIds.length; i += 400) {
    const chunk = paymentIds.slice(i, i + 400)
    const { data, error } = await supabase
      .from("expense_payments")
      .select("amount")
      .eq("pop_id", popId)
      .in("id", chunk)
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudieron sumar los gastos.",
      }
    }
    for (const row of data || []) {
      total += parseMoney(row.amount)
    }
  }

  return {
    success: true,
    data: {
      kind: "expenses",
      count: count ?? 0,
      total: roundMoney(total),
      iva: null,
    },
  }
}

async function sumIssuedInvoiceTotals(
  supabase: SupabaseClient,
  popId: string,
  from: string | null,
  to: string | null,
): Promise<
  { success: true; data: OperationalTotalsData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("invoices_arca")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  if (from) countQuery = countQuery.gte("cbte_fch", from)
  if (to) countQuery = countQuery.lte("cbte_fch", to)
  const { count, error: countErr } = await countQuery
  if (countErr) {
    return {
      success: false,
      error: countErr.message || "No se pudieron contar las facturas.",
    }
  }

  let total = 0
  let iva = 0
  let offset = 0
  while (true) {
    let q = supabase
      .from("invoices_arca")
      .select("imp_total, imp_iva")
      .eq("pop_id", popId)
      .range(offset, offset + SLIM_PAGE - 1)
    if (from) q = q.gte("cbte_fch", from)
    if (to) q = q.lte("cbte_fch", to)
    const { data, error } = await q
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudieron sumar las facturas.",
      }
    }
    const rows = data || []
    for (const row of rows) {
      total += parseMoney(row.imp_total)
      iva += parseMoney(row.imp_iva)
    }
    if (rows.length < SLIM_PAGE) break
    offset += SLIM_PAGE
    if (offset > 200_000) break
  }

  return {
    success: true,
    data: {
      kind: "issued-invoices",
      count: count ?? 0,
      total: roundMoney(total),
      iva: roundMoney(iva),
    },
  }
}

export async function getOperationalTotals(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  kind: OperationalTotalKind,
  from: string | null,
  to: string | null,
): Promise<
  { success: true; data: OperationalTotalsData } | { success: false; error: string }
> {
  if (kind === "sales") {
    return sumSalesTotals(supabase, popId, popSiteId, from, to)
  }
  if (kind === "purchases") {
    return sumPurchasesTotals(supabase, popId, popSiteId, from, to, false)
  }
  if (kind === "received-invoices") {
    return sumPurchasesTotals(supabase, popId, popSiteId, from, to, true)
  }
  if (kind === "expenses") {
    return sumExpensesTotals(supabase, popId, from, to)
  }
  return sumIssuedInvoiceTotals(supabase, popId, from, to)
}
