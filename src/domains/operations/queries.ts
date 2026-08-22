import type { SupabaseClient } from "@supabase/supabase-js"
import { groupChannelOperationSales } from "./channelSales.js"
import type { OperationsListFiltersInput } from "./filters.js"
import {
  applyPurchasesListToolbarFilters,
  applySalesListToolbarFilters,
  counterSaleMatchesOperationsFilters,
  saleMatchesOperationsFilters,
  tableSaleMatchesOperationsFilters,
} from "./filters.js"
import {
  loadArcaBySaleIds,
  loadCounterOrderLabelsBySaleIds,
  loadCounterOrderSummariesBySaleIds,
  loadFiscalPurchaseIdsForPop,
  loadPurchaseDocumentKindsByPurchaseIds,
  loadTableLabelsBySaleIds,
  loadTableSessionSummariesBySaleIds,
  loadUserDisplayNames,
  PURCHASE_DETAIL_SELECT,
  PURCHASE_LIST_SELECT,
  SALE_DETAIL_SELECT,
  SALE_LIST_SELECT,
} from "./loaders.js"
import {
  applyChannelListFieldsToSaleRows,
  mapExpenseLedgerRows,
  mapOperationServiceChargeRow,
  mapPurchaseRows,
  mapSaleRows,
  parseServiceChargeMoney,
  type CounterOrderListSummary,
  type TableSessionListSummary,
} from "./mappers.js"
import {
  DEFAULT_OPERATIONAL_DAY_CLOSE_TIME,
  expandCalendarBoundsForOperationalFetch,
  filterSalesByOperationalPeriod,
  loadPopOperationalContext,
  usesOperationalDayFilter,
} from "./operationalDay.js"
import type {
  GetOperationsListInput,
  OperationExpenseLedgerRow,
  OperationPurchaseRow,
  OperationsListData,
  OperationSaleRow,
  OperationServiceChargePaymentRow,
  OperationServiceChargeRow,
} from "./schema.js"
import {
  DEFAULT_OPERATIONS_LIST_PAGE_SIZE,
  OPERATIONS_LIST_PAGE_SIZES,
} from "./schema.js"
import type { ServiceChargeEffectiveStatus } from "./serviceCharges.js"
import {
  roundServiceChargeMoney,
  todayIsoDateOnly,
} from "./serviceCharges.js"
import {
  localDateExclusiveEndTimestamp,
  localDateStartTimestamp,
} from "./timezone.js"
import { resolveWorkspaceTableListOrder } from "./workspaceTableSort.js"

const OPERATIONS_SALES_LIST_SORT = {
  allowed: {
    sold_at: "sold_at",
    total: "total",
  },
  defaultColumn: "sold_at" as const,
  defaultAscending: false,
}

const OPERATIONS_PURCHASES_LIST_SORT = {
  allowed: {
    created_at: "created_at",
    total: "total",
  },
  defaultColumn: "created_at" as const,
  defaultAscending: false,
}

const OPERATIONS_EXPENSES_LIST_SORT = {
  allowed: {
    entry_date: "entry_date",
  },
  defaultColumn: "entry_date" as const,
  defaultAscending: false,
}

const OPERATIONS_SERVICES_LIST_SORT = {
  allowed: {
    due_date: "due_date",
    created_at: "created_at",
    total: "amount",
  },
  defaultColumn: "created_at" as const,
  defaultAscending: false,
}

function resolveOperationsSalesListOrder(input: GetOperationsListInput) {
  return resolveWorkspaceTableListOrder(
    { sort: input.sort ?? null, ord: input.ord ?? "asc" },
    OPERATIONS_SALES_LIST_SORT,
  )
}

function resolveOperationsPurchasesListOrder(input: GetOperationsListInput) {
  return resolveWorkspaceTableListOrder(
    { sort: input.sort ?? null, ord: input.ord ?? "asc" },
    OPERATIONS_PURCHASES_LIST_SORT,
  )
}

function resolveOperationsExpensesListOrder(input: GetOperationsListInput) {
  return resolveWorkspaceTableListOrder(
    { sort: input.sort ?? null, ord: input.ord ?? "asc" },
    OPERATIONS_EXPENSES_LIST_SORT,
  )
}

function resolveOperationsServicesListOrder(input: GetOperationsListInput) {
  return resolveWorkspaceTableListOrder(
    { sort: input.sort ?? null, ord: input.ord ?? "asc" },
    OPERATIONS_SERVICES_LIST_SORT,
  )
}

function normalizeOperationsListPaging(page: number, pageSize: number) {
  const sizes = new Set<number>(
    OPERATIONS_LIST_PAGE_SIZES as unknown as number[],
  )
  const ps = sizes.has(pageSize) ? pageSize : DEFAULT_OPERATIONS_LIST_PAGE_SIZE
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  return { page: p, pageSize: ps }
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function dateTimeStart(isoDate: string, timeZone: string): string {
  return localDateStartTimestamp(timeZone, isoDate)
}

function dateTimeExclusiveEnd(isoDate: string, timeZone: string): string {
  return localDateExclusiveEndTimestamp(timeZone, isoDate)
}

function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function buildSalesSearchOrClause(raw: string): string | null {
  const t = raw.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  return [
    `customer_name.ilike.${pattern}`,
    `customer_tax_id.ilike.${pattern}`,
    `status.ilike.${pattern}`,
  ].join(",")
}

function buildPurchasesSearchOrClause(raw: string): string | null {
  const t = raw.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  return [
    `supplier_name.ilike.${pattern}`,
    `document_number.ilike.${pattern}`,
    `status.ilike.${pattern}`,
    `purchase_kind.ilike.${pattern}`,
  ].join(",")
}

function buildExpensesSearchOrClause(raw: string): string | null {
  const t = raw.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  return `description.ilike.${pattern}`
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

function appendServiceChargesDateFilter<
  Q extends {
    gte: (col: string, val: string) => Q
    lt: (col: string, val: string) => Q
  },
>(q: Q, dateFrom: string | null, dateTo: string | null, timeZone: string): Q {
  let x = q
  if (dateFrom) x = x.gte("created_at", dateTimeStart(dateFrom, timeZone))
  if (dateTo) x = x.lt("created_at", dateTimeExclusiveEnd(dateTo, timeZone))
  return x
}

const SERVICE_CHARGE_STATUS_SEARCH: Record<string, ServiceChargeEffectiveStatus> =
  {
    pendiente: "pending",
    pending: "pending",
    parcial: "partial",
    partial: "partial",
    pagado: "paid",
    paid: "paid",
    vencido: "overdue",
    vencidos: "overdue",
    overdue: "overdue",
    cancelado: "cancelled",
    cancelados: "cancelled",
    cancelled: "cancelled",
  }

const SERVICE_CHARGE_LIST_SELECT = `
  id,
  client_id,
  service_type_id,
  sequence_index,
  billing_scope,
  period_count,
  payment_mode,
  period_start,
  period_end,
  unit_price,
  discount_mode,
  discount_value,
  amount,
  due_date,
  status,
  cancelled_at,
  notes,
  created_at,
  clients ( name ),
  service_types ( name, billing_period, billing_period_label )
`

export async function resolveServiceChargeSearchIds(
  supabase: SupabaseClient,
  popId: string,
  search: string,
): Promise<{
  chargeId?: string
  status?: ServiceChargeEffectiveStatus
  clientIds?: string[]
  serviceTypeIds?: string[]
  notesPattern?: string
}> {
  const term = search.trim()
  if (!term) return {}
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      term,
    )
  ) {
    return { chargeId: term }
  }

  const status = SERVICE_CHARGE_STATUS_SEARCH[term.toLowerCase()]
  if (status) return { status }

  const pattern = `%${escapeIlikeToken(term)}%`
  const [{ data: clients }, { data: services }] = await Promise.all([
    supabase
      .from("clients")
      .select("id")
      .eq("pop_id", popId)
      .ilike("name", pattern)
      .limit(80),
    supabase
      .from("service_types")
      .select("id")
      .eq("pop_id", popId)
      .ilike("name", pattern)
      .limit(80),
  ])

  return {
    clientIds: (clients ?? []).map((row) => String(row.id)),
    serviceTypeIds: (services ?? []).map((row) => String(row.id)),
    notesPattern: pattern,
  }
}

function applyServiceChargeStatusFilter<
  Q extends {
    eq: (col: string, val: string) => Q
    in: (col: string, val: string[]) => Q
    or: (filters: string) => Q
    lt: (col: string, val: string) => Q
    is: (col: string, val: null) => Q
  },
>(query: Q, status: ServiceChargeEffectiveStatus, today: string): Q {
  if (status === "overdue") {
    return query
      .lt("due_date", today)
      .in("status", ["pending", "partial"])
      .is("cancelled_at", null)
  }
  if (status === "cancelled") {
    return query.or("status.eq.cancelled,cancelled_at.not.is.null")
  }
  if (status === "paid") return query.eq("status", "paid")
  if (status === "partial") return query.eq("status", "partial")
  if (status === "pending") {
    return query.eq("status", "pending").is("cancelled_at", null)
  }
  return query
}

function applyServiceChargeToolbarFilters<
  Q extends {
    eq: (col: string, val: string) => Q
    in: (col: string, val: string[]) => Q
    or: (filters: string) => Q
    lt: (col: string, val: string) => Q
    is: (col: string, val: null) => Q
  },
>(
  query: Q,
  filters: OperationsListFiltersInput | undefined,
  today: string,
): Q {
  if (!filters) return query
  if (filters.serviceStatus) {
    query = applyServiceChargeStatusFilter(query, filters.serviceStatus, today)
  }
  if (filters.serviceScope) {
    query = query.eq("billing_scope", filters.serviceScope)
  }
  return query
}

function applyServiceChargeSearchFilter<
  Q extends {
    eq: (col: string, val: string) => Q
    in: (col: string, val: string[]) => Q
    or: (filters: string) => Q
    lt: (col: string, val: string) => Q
    is: (col: string, val: null) => Q
  },
>(
  query: Q,
  search: Awaited<ReturnType<typeof resolveServiceChargeSearchIds>>,
  today: string,
): Q {
  const hasSearch =
    Boolean(search.chargeId) ||
    Boolean(search.status) ||
    Boolean(search.notesPattern) ||
    (search.clientIds != null && search.clientIds.length > 0) ||
    (search.serviceTypeIds != null && search.serviceTypeIds.length > 0)
  if (!hasSearch) return query
  if (search.chargeId) return query.eq("id", search.chargeId)
  if (search.status) {
    return applyServiceChargeStatusFilter(query, search.status, today)
  }

  const parts: string[] = []
  if (search.notesPattern) {
    parts.push(`notes.ilike.${search.notesPattern}`)
  }
  if (search.clientIds && search.clientIds.length > 0) {
    parts.push(`client_id.in.(${search.clientIds.join(",")})`)
  }
  if (search.serviceTypeIds && search.serviceTypeIds.length > 0) {
    parts.push(`service_type_id.in.(${search.serviceTypeIds.join(",")})`)
  }
  if (parts.length === 0) {
    return query.eq("id", "00000000-0000-0000-0000-000000000000")
  }
  return query.or(parts.join(","))
}

function ok(data: OperationsListData) {
  return { success: true as const, data }
}

function fail(error: string) {
  return { success: false as const, error }
}

export async function getOperationsList(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  input: GetOperationsListInput,
): Promise<
  { success: true; data: OperationsListData } | { success: false; error: string }
> {
  const emptySales: OperationSaleRow[] = []
  const emptyExpenseLedger: OperationExpenseLedgerRow[] = []
  const emptyPurchases: OperationPurchaseRow[] = []
  const emptyServiceCharges: OperationServiceChargeRow[] = []
  const { page: reqPage, pageSize } = normalizeOperationsListPaging(
    input.page,
    input.pageSize,
  )

  try {
    const operational = await loadPopOperationalContext(
      supabase,
      popId,
      popSiteId,
    )
    const popName = operational.popName
    const fiscalSiteId = popSiteId
    const ledgerTimeZone = operational.timeZone

    const { dateFrom, dateTo, search, view, filters: listFilters } = input
    const includeLines = input.include === "full"
    const searchTerm = search.trim()
    const uuidSearch =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        searchTerm,
      )

    const emptyData = (page: number, totalCount = 0): OperationsListData => ({
      popName,
      totalCount,
      page,
      sales: emptySales,
      expenseLedger: emptyExpenseLedger,
      purchases: emptyPurchases,
      serviceCharges: emptyServiceCharges,
    })

    if (
      view === "sales" ||
      view === "sales-report" ||
      view === "tables" ||
      view === "counter"
    ) {
      const isChannelGroupedView = view === "tables" || view === "counter"
      const isAllChannelsSalesView = view === "sales-report"
      const isSalesDateFilteredView =
        view === "sales" ||
        view === "sales-report" ||
        view === "tables" ||
        view === "counter"

      let operationalDayCloseTime = DEFAULT_OPERATIONAL_DAY_CLOSE_TIME
      let salesTimeZone = ledgerTimeZone
      if (isSalesDateFilteredView && (dateFrom || dateTo)) {
        operationalDayCloseTime = operational.operationalDayCloseTime
        salesTimeZone = operational.timeZone
      }

      const useOperationalDayFilter =
        isSalesDateFilteredView &&
        usesOperationalDayFilter(operationalDayCloseTime, dateFrom, dateTo)

      const salesFetchBounds = useOperationalDayFilter
        ? expandCalendarBoundsForOperationalFetch(dateFrom, dateTo)
        : { from: dateFrom, to: dateTo }

      let totalCount = 0
      let safePage = Math.max(1, reqPage)
      let from = (safePage - 1) * pageSize
      let to = from + pageSize - 1

      if (!isChannelGroupedView && !useOperationalDayFilter) {
        let countQuery = supabase
          .from("sales")
          .select("id", { count: "exact", head: true })
          .eq("pop_id", popId)
        if (!isAllChannelsSalesView) {
          countQuery = countQuery
            .neq("sale_channel", "table")
            .neq("sale_channel", "counter")
        }
        countQuery = appendSalesDateFilter(
          countQuery,
          salesFetchBounds.from,
          salesFetchBounds.to,
          salesTimeZone,
        )
        if (uuidSearch) {
          countQuery = countQuery.eq("id", searchTerm)
        } else {
          const orClause = buildSalesSearchOrClause(search)
          if (orClause) countQuery = countQuery.or(orClause)
        }
        if (view === "sales" || view === "sales-report") {
          countQuery = applySalesListToolbarFilters(countQuery, listFilters)
        }

        const { count: countRaw, error: countErr } = await countQuery
        if (countErr) {
          return fail(countErr.message || "No se pudieron cargar las ventas.")
        }

        totalCount = countRaw ?? 0
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
        safePage = Math.min(Math.max(1, reqPage), totalPages)
        from = (safePage - 1) * pageSize
        to = from + pageSize - 1
      }

      let dataQuery = supabase
        .from("sales")
        .select(
          (includeLines ? SALE_DETAIL_SELECT : SALE_LIST_SELECT) as typeof SALE_LIST_SELECT,
        )
        .eq("pop_id", popId)
      if (view === "tables") {
        dataQuery = dataQuery.eq("sale_channel", "table")
      } else if (view === "counter") {
        dataQuery = dataQuery.eq("sale_channel", "counter")
      } else if (!isAllChannelsSalesView) {
        dataQuery = dataQuery
          .neq("sale_channel", "table")
          .neq("sale_channel", "counter")
      }
      dataQuery = appendSalesDateFilter(
        dataQuery,
        salesFetchBounds.from,
        salesFetchBounds.to,
        salesTimeZone,
      )
      if (uuidSearch) {
        dataQuery = dataQuery.eq("id", searchTerm)
      } else {
        const orClause = buildSalesSearchOrClause(search)
        if (orClause) dataQuery = dataQuery.or(orClause)
      }
      if (view === "sales" || view === "sales-report") {
        dataQuery = applySalesListToolbarFilters(dataQuery, listFilters)
      }
      const salesListOrder = resolveOperationsSalesListOrder(input)
      dataQuery = dataQuery.order(salesListOrder.column, {
        ascending: salesListOrder.ascending,
      })
      if (!isChannelGroupedView && !useOperationalDayFilter) {
        dataQuery = dataQuery.range(from, to)
      }

      const { data: saleRows, error: saleErr } = await dataQuery
      if (saleErr) {
        return fail(saleErr.message || "No se pudieron cargar las ventas.")
      }

      const saleIds = (saleRows || []).map((r) => String(r.id))
      const arcaBySaleId = await loadArcaBySaleIds(
        supabase,
        popId,
        fiscalSiteId,
        saleIds,
      )
      const tableLabelBySessionId =
        view === "tables" || isAllChannelsSalesView
          ? await loadTableLabelsBySaleIds(
              supabase,
              popId,
              (saleRows || []) as Array<Record<string, unknown>>,
            )
          : new Map<string, string>()
      const counterOrderLabelByOrderId =
        view === "counter" || isAllChannelsSalesView
          ? await loadCounterOrderLabelsBySaleIds(
              supabase,
              popId,
              (saleRows || []) as Array<Record<string, unknown>>,
            )
          : new Map<string, string>()
      const tableSummaryBySessionId =
        view === "tables"
          ? await loadTableSessionSummariesBySaleIds(
              supabase,
              popId,
              (saleRows || []) as Array<Record<string, unknown>>,
            )
          : new Map<string, TableSessionListSummary>()
      const counterSummaryByOrderId =
        view === "counter"
          ? await loadCounterOrderSummariesBySaleIds(
              supabase,
              popId,
              (saleRows || []) as Array<Record<string, unknown>>,
            )
          : new Map<string, CounterOrderListSummary>()
      const channelUserIds = new Set<string>()
      for (const summary of tableSummaryBySessionId.values()) {
        if (summary.openedBy) channelUserIds.add(summary.openedBy)
        if (summary.closedBy) channelUserIds.add(summary.closedBy)
        if (summary.waiterUserId) channelUserIds.add(summary.waiterUserId)
      }
      for (const summary of counterSummaryByOrderId.values()) {
        if (summary.openedBy) channelUserIds.add(summary.openedBy)
        if (summary.cancelledBy) channelUserIds.add(summary.cancelledBy)
      }
      for (const row of saleRows || []) {
        const createdBy =
          row.created_by != null ? String(row.created_by).trim() : ""
        if (createdBy) channelUserIds.add(createdBy)
      }
      const userNames = await loadUserDisplayNames(supabase, [
        ...channelUserIds,
      ])
      let sales = mapSaleRows(
        (saleRows || []) as Array<Record<string, unknown>>,
        arcaBySaleId,
        fiscalSiteId,
        tableLabelBySessionId,
        counterOrderLabelByOrderId,
        userNames,
      )
      if (useOperationalDayFilter) {
        sales = filterSalesByOperationalPeriod(
          sales,
          dateFrom,
          dateTo,
          salesTimeZone,
          operationalDayCloseTime,
        )
      }
      if (useOperationalDayFilter && !isChannelGroupedView) {
        sales = sales.filter((sale) =>
          saleMatchesOperationsFilters(sale, listFilters),
        )
        totalCount = sales.length
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
        safePage = Math.min(Math.max(1, reqPage), totalPages)
        from = (safePage - 1) * pageSize
        to = from + pageSize - 1
        sales = sales.slice(from, to + 1)
      }
      if (isChannelGroupedView) {
        sales = applyChannelListFieldsToSaleRows(sales, {
          view: view === "tables" ? "table" : "counter",
          tableSummaryBySessionId,
          counterSummaryByOrderId,
          userNames,
        })
        sales = groupChannelOperationSales(
          sales,
          view === "tables" ? "table" : "counter",
        )
        sales =
          view === "tables"
            ? sales.filter((sale) =>
                tableSaleMatchesOperationsFilters(sale, listFilters),
              )
            : sales.filter((sale) =>
                counterSaleMatchesOperationsFilters(sale, listFilters),
              )
        totalCount = sales.length
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
        safePage = Math.min(Math.max(1, reqPage), totalPages)
        from = (safePage - 1) * pageSize
        to = from + pageSize - 1
        sales = sales.slice(from, to + 1)
      }

      return ok({
        popName,
        totalCount,
        page: safePage,
        sales,
        expenseLedger: emptyExpenseLedger,
        purchases: emptyPurchases,
        serviceCharges: emptyServiceCharges,
      })
    }

    if (view === "purchases") {
      let fiscalPurchaseIds: string[] | null = null
      if (input.fiscalOnly) {
        fiscalPurchaseIds = await loadFiscalPurchaseIdsForPop(supabase, popId)
        if (fiscalPurchaseIds.length === 0) {
          return ok(emptyData(1, 0))
        }
      }

      let countQuery = supabase
        .from("purchases")
        .select("id", { count: "exact", head: true })
        .eq("pop_id", popId)
        .neq("status", "draft")
      if (fiscalPurchaseIds) {
        countQuery = countQuery.in("id", fiscalPurchaseIds)
      }
      countQuery = appendPurchasesDateFilter(
        countQuery,
        dateFrom,
        dateTo,
        ledgerTimeZone,
      )
      const orClause = buildPurchasesSearchOrClause(search)
      if (orClause) countQuery = countQuery.or(orClause)
      countQuery = applyPurchasesListToolbarFilters(countQuery, listFilters)

      const { count: countRaw, error: countErr } = await countQuery
      if (countErr) {
        return fail(countErr.message || "No se pudieron cargar las compras.")
      }

      const totalCount = countRaw ?? 0
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
      const safePage = Math.min(Math.max(1, reqPage), totalPages)
      const from = (safePage - 1) * pageSize
      const to = from + pageSize - 1

      let dataQuery = supabase
        .from("purchases")
        .select(
          (includeLines
            ? PURCHASE_DETAIL_SELECT
            : PURCHASE_LIST_SELECT) as typeof PURCHASE_LIST_SELECT,
        )
        .eq("pop_id", popId)
        .neq("status", "draft")
      if (fiscalPurchaseIds) {
        dataQuery = dataQuery.in("id", fiscalPurchaseIds)
      }
      dataQuery = appendPurchasesDateFilter(
        dataQuery,
        dateFrom,
        dateTo,
        ledgerTimeZone,
      )
      if (orClause) dataQuery = dataQuery.or(orClause)
      dataQuery = applyPurchasesListToolbarFilters(dataQuery, listFilters)
      const purchasesListOrder = resolveOperationsPurchasesListOrder(input)
      dataQuery = dataQuery
        .order(purchasesListOrder.column, {
          ascending: purchasesListOrder.ascending,
        })
        .range(from, to)

      const { data: purchaseRows, error: purchaseErr } = await dataQuery
      if (purchaseErr) {
        return fail(
          purchaseErr.message || "No se pudieron cargar las compras.",
        )
      }

      const purchaseUserNames = await loadUserDisplayNames(
        supabase,
        (purchaseRows || [])
          .map((row) =>
            row.created_by != null ? String(row.created_by).trim() : "",
          )
          .filter(Boolean),
      )
      const documentKindByPurchaseId =
        await loadPurchaseDocumentKindsByPurchaseIds(
          supabase,
          popId,
          (purchaseRows || []).map((row) => String(row.id)),
        )
      const purchases = mapPurchaseRows(
        (purchaseRows || []) as Array<Record<string, unknown>>,
        purchaseUserNames,
        documentKindByPurchaseId,
      ).filter((purchase) => !input.fiscalOnly || purchase.accruesInputVat)

      return ok({
        popName,
        totalCount,
        page: safePage,
        sales: emptySales,
        expenseLedger: emptyExpenseLedger,
        purchases,
        serviceCharges: emptyServiceCharges,
      })
    }

    if (view === "services") {
      const today = todayIsoDateOnly()
      const searchResolved = await resolveServiceChargeSearchIds(
        supabase,
        popId,
        search,
      )

      let countQuery = supabase
        .from("service_charges")
        .select("id", { count: "exact", head: true })
        .eq("pop_id", popId)
      countQuery = appendServiceChargesDateFilter(
        countQuery,
        dateFrom,
        dateTo,
        ledgerTimeZone,
      )
      countQuery = applyServiceChargeSearchFilter(
        countQuery,
        searchResolved,
        today,
      )
      countQuery = applyServiceChargeToolbarFilters(
        countQuery,
        listFilters,
        today,
      )

      const { count: countRaw, error: countErr } = await countQuery
      if (countErr) {
        return fail(countErr.message || "No se pudieron cargar los servicios.")
      }

      const totalCount = countRaw ?? 0
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
      const safePage = Math.min(Math.max(1, reqPage), totalPages)
      const from = (safePage - 1) * pageSize
      const to = from + pageSize - 1

      let dataQuery = supabase
        .from("service_charges")
        .select(SERVICE_CHARGE_LIST_SELECT)
        .eq("pop_id", popId)
      dataQuery = appendServiceChargesDateFilter(
        dataQuery,
        dateFrom,
        dateTo,
        ledgerTimeZone,
      )
      dataQuery = applyServiceChargeSearchFilter(
        dataQuery,
        searchResolved,
        today,
      )
      dataQuery = applyServiceChargeToolbarFilters(
        dataQuery,
        listFilters,
        today,
      )
      const servicesListOrder = resolveOperationsServicesListOrder(input)
      dataQuery = dataQuery
        .order(servicesListOrder.column, {
          ascending: servicesListOrder.ascending,
        })
        .range(from, to)

      const { data: chargeRows, error: chargeErr } = await dataQuery
      if (chargeErr) {
        return fail(chargeErr.message || "No se pudieron cargar los servicios.")
      }

      const chargeIds = (chargeRows ?? []).map((row) => String(row.id))
      const paidByChargeId = new Map<string, number>()
      const paymentsByChargeId = new Map<
        string,
        OperationServiceChargePaymentRow[]
      >()

      if (chargeIds.length > 0) {
        const { data: paymentRows, error: paymentErr } = await supabase
          .from("service_charge_payments")
          .select("id, service_charge_id, amount, paid_at, payment_kind, notes")
          .eq("pop_id", popId)
          .in("service_charge_id", chargeIds)
          .order("paid_at", { ascending: false })
        if (paymentErr) {
          return fail(paymentErr.message || "No se pudieron cargar los cobros.")
        }
        for (const payment of paymentRows ?? []) {
          const chargeId = String(payment.service_charge_id)
          const amount = parseServiceChargeMoney(payment.amount)
          paidByChargeId.set(
            chargeId,
            roundServiceChargeMoney(
              (paidByChargeId.get(chargeId) ?? 0) + amount,
            ),
          )
          const list = paymentsByChargeId.get(chargeId) ?? []
          list.push({
            id: String(payment.id),
            amount,
            paidAt: String(payment.paid_at ?? ""),
            paymentKind:
              payment.payment_kind != null
                ? String(payment.payment_kind)
                : null,
            notes: String(payment.notes ?? ""),
          })
          paymentsByChargeId.set(chargeId, list)
        }
      }

      const serviceCharges = (chargeRows ?? []).map((row) =>
        mapOperationServiceChargeRow(
          row as Record<string, unknown>,
          paidByChargeId,
          paymentsByChargeId,
          today,
        ),
      )

      return ok({
        popName,
        totalCount,
        page: safePage,
        sales: emptySales,
        expenseLedger: emptyExpenseLedger,
        purchases: emptyPurchases,
        serviceCharges,
      })
    }

    const expenseSourceTypes = listFilters?.expenseSource
      ? [listFilters.expenseSource]
      : (["expense_payment", "expense_void"] as const)

    let countQuery = supabase
      .from("accounting_entries")
      .select("id", { count: "exact", head: true })
      .eq("pop_id", popId)
      .in("source_type", [...expenseSourceTypes])
      .eq("status", "posted")
    countQuery = appendExpensesDateFilter(countQuery, dateFrom, dateTo)
    const expenseOrClause = buildExpensesSearchOrClause(search)
    if (expenseOrClause) countQuery = countQuery.or(expenseOrClause)

    const { count: countRaw, error: countErr } = await countQuery
    if (countErr) {
      return fail(
        countErr.message || "No se pudieron cargar los asientos de gastos.",
      )
    }

    const totalCount = countRaw ?? 0
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
    const safePage = Math.min(Math.max(1, reqPage), totalPages)
    const from = (safePage - 1) * pageSize
    const to = from + pageSize - 1

    let dataQuery = supabase
      .from("accounting_entries")
      .select(
        "id, entry_date, description, source_type, source_id, status, created_at, posted_at, created_by",
      )
      .eq("pop_id", popId)
      .in("source_type", [...expenseSourceTypes])
      .eq("status", "posted")
    dataQuery = appendExpensesDateFilter(dataQuery, dateFrom, dateTo)
    if (expenseOrClause) dataQuery = dataQuery.or(expenseOrClause)
    const expensesListOrder = resolveOperationsExpensesListOrder(input)
    dataQuery = dataQuery
      .order(expensesListOrder.column, {
        ascending: expensesListOrder.ascending,
      })
      .range(from, to)

    const { data: aeRows, error: aeErr } = await dataQuery
    if (aeErr) {
      return fail(
        aeErr.message || "No se pudieron cargar los asientos de gastos.",
      )
    }

    const expenseUserNames = await loadUserDisplayNames(
      supabase,
      (aeRows || [])
        .map((row) =>
          row.created_by != null ? String(row.created_by).trim() : "",
        )
        .filter(Boolean),
    )

    const expenseLedger = await mapExpenseLedgerRows(
      supabase,
      popId,
      (aeRows || []) as Array<Record<string, unknown>>,
      expenseUserNames,
    )

    return ok({
      popName,
      totalCount,
      page: safePage,
      sales: emptySales,
      expenseLedger,
      purchases: emptyPurchases,
      serviceCharges: emptyServiceCharges,
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error desconocido"
    return fail(message)
  }
}
