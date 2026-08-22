import { z } from "zod"

export const PURCHASE_ORDER_TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_PURCHASE_ORDER_TABLE_PAGE_SIZE = 25

export const listPurchaseOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_PURCHASE_ORDER_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  dateFrom: z.string().optional().default(""),
  dateTo: z.string().optional().default(""),
})

export type ListPurchaseOrdersQuery = {
  page: number
  pageSize: number
  search: string
  dateFrom: string
  dateTo: string
}

export function toListPurchaseOrdersQuery(
  parsed: z.infer<typeof listPurchaseOrdersQuerySchema>,
): ListPurchaseOrdersQuery {
  const pageSize = PURCHASE_ORDER_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof PURCHASE_ORDER_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_PURCHASE_ORDER_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    dateFrom: parsed.dateFrom.trim(),
    dateTo: parsed.dateTo.trim(),
  }
}

export const createPurchaseOrderBodySchema = z.object({
  checkoutSnapshot: z.unknown(),
  subtotal: z.number(),
  discountTotal: z.number(),
  total: z.number(),
  supplierId: z.string().uuid().nullable(),
  supplierName: z.string(),
  supplierTaxId: z.string().nullable(),
  metadata: z.unknown().optional(),
})

export type CreatePurchaseOrderBody = z.infer<typeof createPurchaseOrderBodySchema>

export type PurchaseOrderLineSummary = {
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

export type PurchaseOrderMetadata = {
  comprobanteLabel?: string | null
  paymentLabel?: string | null
  discountLabel?: string | null
  lineSummaries?: PurchaseOrderLineSummary[]
}

export type PurchaseOrderTableRow = {
  id: string
  orderNumber: number
  supplierName: string
  supplierTaxId: string | null
  subtotal: number
  discountTotal: number
  total: number
  status: "active" | "converted" | "cancelled"
  createdAt: string
  itemCount: number
}

export type PurchaseOrderDetail = PurchaseOrderTableRow & {
  supplierId: string | null
  checkoutSnapshot: unknown
  metadata: PurchaseOrderMetadata
}

export type PurchaseOrderListData = {
  rows: PurchaseOrderTableRow[]
  totalCount: number
  page: number
  pageSize: number
}
