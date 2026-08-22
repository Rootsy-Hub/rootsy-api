import { z } from "zod"

export const QUOTE_TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_QUOTE_TABLE_PAGE_SIZE = 25

export const listQuotesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_QUOTE_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  dateFrom: z.string().optional().default(""),
  dateTo: z.string().optional().default(""),
})

export type ListQuotesQuery = {
  page: number
  pageSize: number
  search: string
  dateFrom: string
  dateTo: string
}

export function toListQuotesQuery(
  parsed: z.infer<typeof listQuotesQuerySchema>,
): ListQuotesQuery {
  const pageSize = QUOTE_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof QUOTE_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_QUOTE_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    dateFrom: parsed.dateFrom.trim(),
    dateTo: parsed.dateTo.trim(),
  }
}

export const createQuoteBodySchema = z.object({
  checkoutSnapshot: z.unknown(),
  subtotal: z.number(),
  discountTotal: z.number(),
  total: z.number(),
  clientId: z.string().uuid().nullable(),
  customerName: z.string(),
  customerTaxId: z.string().nullable(),
  metadata: z.unknown().optional(),
})

export type CreateQuoteBody = z.infer<typeof createQuoteBodySchema>

export type SaleQuoteLineSummary = {
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

export type SaleQuoteLineDiscount = {
  label: string
  amount: number
}

export type SaleQuoteLineGroupLine = {
  name: string
  quantity: number
  unitListPrice: number
  listLineTotal: number
  lineTotal: number
  discounts: SaleQuoteLineDiscount[]
}

export type SaleQuoteLineGroup = {
  id: string
  category: string
  lines: SaleQuoteLineGroupLine[]
  promotionDiscount: SaleQuoteLineDiscount | null
}

export type SaleQuoteMetadata = {
  comprobanteLabel?: string | null
  paymentLabel?: string | null
  discountLabel?: string | null
  lineSummaries?: SaleQuoteLineSummary[]
  lineGroups?: SaleQuoteLineGroup[]
}

export type SaleQuoteTableRow = {
  id: string
  quoteNumber: number
  customerName: string
  customerTaxId: string | null
  subtotal: number
  discountTotal: number
  total: number
  status: "active" | "converted" | "cancelled"
  createdAt: string
  itemCount: number
}

export type SaleQuoteDetail = SaleQuoteTableRow & {
  clientId: string | null
  checkoutSnapshot: unknown
  metadata: SaleQuoteMetadata
}

export type QuoteListData = {
  rows: SaleQuoteTableRow[]
  totalCount: number
  page: number
  pageSize: number
}
