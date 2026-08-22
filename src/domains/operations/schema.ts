import { z } from "zod"
import type { OperationsListFiltersInput } from "./filters.js"
import type { SaleLineDisplay, SaleSnapshotTotals } from "./saleSnapshot.js"
import type {
  ServiceBillingPeriod,
  ServiceChargeBillingScope,
  ServiceChargeEffectiveStatus,
  ServiceChargePaymentMode,
  ServiceChargeStoredStatus,
  ServiceDiscountMode,
} from "./serviceCharges.js"

export const OPERATIONS_LIST_VIEWS = [
  "sales",
  "sales-report",
  "tables",
  "counter",
  "purchases",
  "expenses",
  "services",
] as const

export type OperationsListView = (typeof OPERATIONS_LIST_VIEWS)[number]

export const OPERATIONS_LIST_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_OPERATIONS_LIST_PAGE_SIZE = 25

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v == null ? undefined : v === "true" || v === "1"))

const emptyToNull = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim() ?? ""
    return t.length > 0 ? t : null
  })

const commaIds = z
  .string()
  .optional()
  .transform((v) => {
    if (!v?.trim()) return undefined
    const ids = [
      ...new Set(
        v
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ]
    return ids.length > 0 ? ids : undefined
  })

export const listOperationsQuerySchema = z.object({
  view: z.enum(OPERATIONS_LIST_VIEWS),
  dateFrom: emptyToNull,
  dateTo: emptyToNull,
  q: z.string().optional().default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .default(DEFAULT_OPERATIONS_LIST_PAGE_SIZE)
    .transform((n) =>
      (OPERATIONS_LIST_PAGE_SIZES as readonly number[]).includes(n)
        ? n
        : DEFAULT_OPERATIONS_LIST_PAGE_SIZE,
    ),
  sort: z.string().optional().nullable(),
  ord: z.enum(["asc", "desc"]).optional(),
  fiscalOnly: boolQuery,
  saleStatus: z
    .enum(["completed", "partial", "cancelled"])
    .optional(),
  saleWithDiscount: boolQuery,
  tableSession: z.enum(["open", "closed"]).optional(),
  counterStatus: z
    .enum(["preparing", "dispatched", "delivered", "cancelled"])
    .optional(),
  counterFulfillment: z.enum(["pickup", "delivery"]).optional(),
  purchaseKind: z
    .enum(["merchandise", "raw_material", "supply", "mixed"])
    .optional(),
  expenseSource: z.enum(["expense_payment", "expense_void"]).optional(),
  serviceStatus: z
    .enum(["pending", "partial", "paid", "overdue", "cancelled"])
    .optional(),
  serviceScope: z
    .enum(["one_period", "multi_period", "subscription"])
    .optional(),
  include: z.enum(["slim", "full"]).optional().default("slim"),
})

export type ListOperationsQuery = z.infer<typeof listOperationsQuerySchema>

export const saleChargesQuerySchema = z.object({
  groupedSaleIds: commaIds,
  tableSessionId: emptyToNull,
  counterOrderId: emptyToNull,
})

export type SaleChargesQuery = z.infer<typeof saleChargesQuerySchema>

export const accountingQuerySchema = z.object({
  view: z.enum(OPERATIONS_LIST_VIEWS),
  operationId: z.string().min(1),
  groupedSaleIds: commaIds,
})

export type AccountingQuery = z.infer<typeof accountingQuerySchema>

export const ticketQuerySchema = z.object({
  tableSessionId: emptyToNull,
  counterOrderId: emptyToNull,
})

export type TicketQuery = z.infer<typeof ticketQuerySchema>

export type GetOperationsListInput = {
  view: OperationsListView
  dateFrom: string | null
  dateTo: string | null
  search: string
  page: number
  pageSize: number
  fiscalOnly?: boolean
  filters?: OperationsListFiltersInput
  sort?: string | null
  ord?: "asc" | "desc"
  /** `full` incluye line_items (estadísticas / reportes). Default slim. */
  include?: "slim" | "full"
}

export type OperationSaleLineItem = {
  articleId: string | null
  recipeId: string | null
  promotionId: string | null
  lineKind: "article" | "recipe" | "promotion" | null
  nameSnapshot: string
  quantity: number
  unitPrice: number
  lineTotal: number
  iva: number
  lineDiscount: number
  itemDiscountMode: "porcentaje" | "fijo" | null
  itemDiscountValue: number | null
  itemDiscountAmount: number
  lineSubtotal: number | null
  comment: string | null
  discountSource: "none" | "catalog" | "manual" | "quantity_deal" | "combo" | null
  promotionDealId: string | null
  promotionDealName: string | null
  lineGroupId: string | null
  listLineTotal: number | null
  taxBase: number | null
  taxAmount: number | null
  generalDiscountShare: number | null
  display: SaleLineDisplay | null
  promotionSnapshot: {
    listTotal?: number
    promoDiscount?: number
    components?: Array<{
      name_snapshot?: string
      quantity?: number
      article_id?: string | null
      recipe_id?: string | null
      slot_id?: string | null
    }>
  } | null
}

export type OperationSalePayment = {
  amount: number
  methodName: string
}

export type OperationSaleArcaInvoice = {
  id: string
  tipoLabel: string
  arcaCbteTipo: number
  arcaRegimen: string
  ptoVta: number
  cbteNro: string
  cbteFch: string
  docTipo: number | null
  docNro: string
  receptorRazonSocial: string
  impTotal: number
  impNeto: number
  impIva: number
  cae: string | null
  caeFchVto: string | null
  status: string
}

export type OperationSaleQuantityDealSummary = {
  promotionId: string
  promotionName: string
  discountAmount: number
}

export type OperationSaleDiscountInfo = {
  itemDiscountTotal: number
  generalDiscountAmount: number
  generalDiscountMode: "porcentaje" | "fijo" | null
  generalDiscountValue: number | null
  subtotalBeforeGeneralDiscount: number | null
  quantityDealApplications: OperationSaleQuantityDealSummary[]
}

export type OperationSaleSnapshotInfo = {
  version: number | null
  totals: SaleSnapshotTotals | null
}

export type OperationSaleChannel = "pos" | "table" | "counter"

export type OperationSaleDetailContext = {
  channel: OperationSaleChannel
  soldAt: string | null
  soldByName: string | null
  customerName: string | null
  tableLabel: string | null
  openedAt: string | null
  closedAt: string | null
  openedByName: string | null
  closedByName: string | null
  waiterName: string | null
  guestCount: number | null
  note: string | null
  counterOrderLabel: string | null
  fulfillmentType: "pickup" | "delivery" | null
  deliveryAddress: string | null
  phone: string | null
  driverName: string | null
  estimatedMinutes: number | null
  deliveredAt: string | null
}

export type OperationSaleChargeRow = {
  saleId: string
  soldAt: string
  amount: number
  methodName: string
  comprobanteLabel: string | null
  hasComprobante: boolean
  sale: OperationSaleRow
}

export type OperationSaleRow = {
  id: string
  soldAt: string
  status: string
  saleChannel: OperationSaleChannel
  saleAmount: number
  total: number
  subtotal: number
  taxTotal: number
  discountTotal: number
  discountInfo: OperationSaleDiscountInfo
  snapshotInfo: OperationSaleSnapshotInfo
  clientId: string | null
  customerName: string | null
  customerTaxId: string | null
  invoiceTypeLabel: string | null
  accruesOutputVat: boolean
  arcaInvoice: OperationSaleArcaInvoice | null
  currency: string
  lineItems: OperationSaleLineItem[]
  payments: OperationSalePayment[]
  paymentMethodLabel: string
  tableLabel: string | null
  counterOrderLabel: string | null
  tableSessionId?: string | null
  counterOrderId?: string | null
  channelOrderTotal?: number | null
  channelPaidTotal?: number | null
  groupedSaleIds?: string[]
  isChannelGrouped?: boolean
  soldByName: string | null
  customerIvaConditionLabel: string
  channelOpenedAt?: string | null
  channelOpenedByName?: string | null
  channelClosedAt?: string | null
  channelClosedByName?: string | null
  channelWaiterName?: string | null
  channelCounterStatus?: string | null
  channelFulfillmentType?: "pickup" | "delivery" | null
}

export type OperationExpenseLedgerRow = {
  entryId: string
  expenseId: string | null
  expensePaymentId: string | null
  sourceType: "expense_payment" | "expense_void"
  operationDate: string
  operationAt: string
  amount: number
  expenseAmount: number | null
  categoryName: string
  description: string
  paymentMethodLabel: string
  recordedByName: string | null
}

export type OperationServiceChargePaymentRow = {
  id: string
  amount: number
  paidAt: string
  paymentKind: string | null
  notes: string
}

export type OperationServiceChargeRow = {
  id: string
  createdAt: string
  dueDate: string
  clientId: string
  clientName: string
  serviceTypeId: string
  serviceName: string
  billingPeriod: ServiceBillingPeriod
  billingPeriodLabel: string | null
  billingScope: ServiceChargeBillingScope
  paymentMode: ServiceChargePaymentMode
  periodCount: number
  sequenceIndex: number
  periodStart: string | null
  periodEnd: string | null
  periodDisplay: string
  unitPrice: number
  discountMode: ServiceDiscountMode
  discountValue: number | null
  discountAmount: number
  amount: number
  paidTotal: number
  balance: number
  storedStatus: ServiceChargeStoredStatus
  effectiveStatus: ServiceChargeEffectiveStatus
  cancelledAt: string | null
  notes: string
  payments: OperationServiceChargePaymentRow[]
}

export type OperationPurchaseLineItem = {
  articleId: string | null
  nameSnapshot: string
  quantity: number
  unitCost: number
  lineTotal: number
  iva: number
  itemDiscountMode: "porcentaje" | "fijo" | null
  itemDiscountValue: number | null
  itemDiscountAmount: number
  lineSubtotal: number | null
  comment: string | null
}

export type OperationPurchaseDiscountInfo = OperationSaleDiscountInfo

export type OperationPurchasePayment = {
  amount: number
  methodName: string
  paidAt: string
}

export type OperationPurchaseRow = {
  id: string
  operationDate: string
  operationAt: string
  status: string
  purchaseKind: string
  subtotal: number
  total: number
  taxTotal: number
  paidTotal: number
  supplierId: string | null
  supplierName: string
  documentNumber: string | null
  currency: string
  discountTotal: number
  discountInfo: OperationPurchaseDiscountInfo
  lineItems: OperationPurchaseLineItem[]
  payments: OperationPurchasePayment[]
  paymentMethodLabel: string
  purchasedByName: string | null
  documentKindLabel: string | null
  accruesInputVat: boolean
  supplierIvaConditionLabel: string
  vatIncludedEstimate: number | null
}

export type OperationAccountingLineRow = {
  id: string
  accountCode: string
  accountName: string
  debitAmount: number
  creditAmount: number
  lineDescription: string | null
}

export type OperationAccountingEntryDetail = {
  id: string
  entryNumber: number
  entryDate: string
  description: string
  sourceType: string
  status: string
  totalDebit: number
  totalCredit: number
  lines: OperationAccountingLineRow[]
}

export type OperationsListData = {
  popName: string
  totalCount: number
  page: number
  sales: OperationSaleRow[]
  expenseLedger: OperationExpenseLedgerRow[]
  purchases: OperationPurchaseRow[]
  serviceCharges: OperationServiceChargeRow[]
}

export function filtersFromListQuery(
  input: ListOperationsQuery,
): OperationsListFiltersInput {
  return {
    ...(input.saleStatus ? { saleStatus: input.saleStatus } : {}),
    ...(input.saleWithDiscount ? { saleWithDiscount: true } : {}),
    ...(input.tableSession ? { tableSession: input.tableSession } : {}),
    ...(input.counterStatus ? { counterStatus: input.counterStatus } : {}),
    ...(input.counterFulfillment
      ? { counterFulfillment: input.counterFulfillment }
      : {}),
    ...(input.purchaseKind ? { purchaseKind: input.purchaseKind } : {}),
    ...(input.expenseSource ? { expenseSource: input.expenseSource } : {}),
    ...(input.serviceStatus ? { serviceStatus: input.serviceStatus } : {}),
    ...(input.serviceScope ? { serviceScope: input.serviceScope } : {}),
  }
}

export function listInputFromQuery(
  input: ListOperationsQuery,
): GetOperationsListInput {
  return {
    view: input.view,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    search: input.q,
    page: input.page,
    pageSize: input.pageSize,
    fiscalOnly: input.fiscalOnly,
    filters: filtersFromListQuery(input),
    sort: input.sort ?? null,
    ord: input.ord,
    include: input.include,
  }
}
