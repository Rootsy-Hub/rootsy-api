export const OPERATIONS_SALE_STATUS_FILTERS = [
  "completed",
  "partial",
  "cancelled",
] as const

export type OperationsSaleStatusFilter =
  (typeof OPERATIONS_SALE_STATUS_FILTERS)[number]

export const OPERATIONS_TABLE_SESSION_FILTERS = ["open", "closed"] as const

export type OperationsTableSessionFilter =
  (typeof OPERATIONS_TABLE_SESSION_FILTERS)[number]

export const OPERATIONS_COUNTER_STATUS_FILTERS = [
  "preparing",
  "dispatched",
  "delivered",
  "cancelled",
] as const

export type OperationsCounterStatusFilter =
  (typeof OPERATIONS_COUNTER_STATUS_FILTERS)[number]

export const OPERATIONS_COUNTER_FULFILLMENT_FILTERS = [
  "pickup",
  "delivery",
] as const

export type OperationsCounterFulfillmentFilter =
  (typeof OPERATIONS_COUNTER_FULFILLMENT_FILTERS)[number]

export const OPERATIONS_PURCHASE_KIND_FILTERS = [
  "merchandise",
  "raw_material",
  "supply",
  "mixed",
] as const

export type OperationsPurchaseKindFilter =
  (typeof OPERATIONS_PURCHASE_KIND_FILTERS)[number]

export const OPERATIONS_EXPENSE_SOURCE_FILTERS = [
  "expense_payment",
  "expense_void",
] as const

export type OperationsExpenseSourceFilter =
  (typeof OPERATIONS_EXPENSE_SOURCE_FILTERS)[number]

export const OPERATIONS_SERVICE_STATUS_FILTERS = [
  "pending",
  "partial",
  "paid",
  "overdue",
  "cancelled",
] as const

export type OperationsServiceStatusFilter =
  (typeof OPERATIONS_SERVICE_STATUS_FILTERS)[number]

export const OPERATIONS_SERVICE_SCOPE_FILTERS = [
  "one_period",
  "multi_period",
  "subscription",
] as const

export type OperationsServiceScopeFilter =
  (typeof OPERATIONS_SERVICE_SCOPE_FILTERS)[number]

export type OperationsListFiltersInput = {
  saleStatus?: OperationsSaleStatusFilter
  saleWithDiscount?: boolean
  tableSession?: OperationsTableSessionFilter
  counterStatus?: OperationsCounterStatusFilter
  counterFulfillment?: OperationsCounterFulfillmentFilter
  purchaseKind?: OperationsPurchaseKindFilter
  expenseSource?: OperationsExpenseSourceFilter
  serviceStatus?: OperationsServiceStatusFilter
  serviceScope?: OperationsServiceScopeFilter
}

export function saleMatchesOperationsFilters(
  sale: { status: string; discountTotal: number },
  filters: OperationsListFiltersInput | undefined,
): boolean {
  if (!filters) return true
  if (filters.saleStatus && sale.status !== filters.saleStatus) return false
  if (filters.saleWithDiscount && sale.discountTotal <= 0) return false
  return true
}

export function tableSaleMatchesOperationsFilters(
  sale: { channelClosedAt?: string | null },
  filters: OperationsListFiltersInput | undefined,
): boolean {
  if (!filters?.tableSession) return true
  const closed = Boolean(sale.channelClosedAt)
  return filters.tableSession === "closed" ? closed : !closed
}

export function counterSaleMatchesOperationsFilters(
  sale: {
    channelCounterStatus?: string | null
    channelFulfillmentType?: "pickup" | "delivery" | null
  },
  filters: OperationsListFiltersInput | undefined,
): boolean {
  if (!filters) return true
  if (
    filters.counterStatus &&
    sale.channelCounterStatus !== filters.counterStatus
  ) {
    return false
  }
  if (
    filters.counterFulfillment &&
    sale.channelFulfillmentType !== filters.counterFulfillment
  ) {
    return false
  }
  return true
}

export function applySalesListToolbarFilters<
  Q extends {
    eq: (col: string, val: string) => Q
    gt: (col: string, val: number) => Q
  },
>(query: Q, filters: OperationsListFiltersInput | undefined): Q {
  if (!filters) return query
  if (filters.saleStatus) query = query.eq("status", filters.saleStatus)
  if (filters.saleWithDiscount) query = query.gt("discount_total", 0)
  return query
}

export function applyPurchasesListToolbarFilters<
  Q extends { eq: (col: string, val: string) => Q },
>(query: Q, filters: OperationsListFiltersInput | undefined): Q {
  if (filters?.purchaseKind) {
    return query.eq("purchase_kind", filters.purchaseKind)
  }
  return query
}
