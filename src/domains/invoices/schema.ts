import { z } from "zod"

export const INVOICE_TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_INVOICE_TABLE_PAGE_SIZE = 25
export const INVOICE_TABLE_SORT_KEYS = [
  "cbte_fch",
  "imp_total",
  "receptor",
  "status",
] as const
export const INVOICE_STATUS_VALUES = [
  "draft",
  "pending_afip",
  "authorized",
  "rejected",
  "cancelled",
] as const
export const INVOICE_RECIBO_X_FILTER = "recibo_x" as const

export const listInvoicesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_INVOICE_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  status: z.string().optional().default(""),
  cbteTipo: z.string().optional().default(""),
  dateFrom: z.string().optional().default(""),
  dateTo: z.string().optional().default(""),
  sort: z.enum(INVOICE_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type InvoiceCbteTipoFilter = number | typeof INVOICE_RECIBO_X_FILTER | ""

export type ListInvoicesQuery = {
  page: number
  pageSize: number
  search: string
  status: string
  cbteTipo: InvoiceCbteTipoFilter
  dateFrom: string
  dateTo: string
  sort: string | null
  ord: "asc" | "desc"
}

function parseCbteTipo(raw: string): InvoiceCbteTipoFilter {
  const value = raw.trim()
  if (value === INVOICE_RECIBO_X_FILTER || value === "x") {
    return INVOICE_RECIBO_X_FILTER
  }
  const n = Number(value)
  if (Number.isInteger(n) && n >= 1) return n
  return ""
}

export function toListInvoicesQuery(
  parsed: z.infer<typeof listInvoicesQuerySchema>,
): ListInvoicesQuery {
  const pageSize = INVOICE_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof INVOICE_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_INVOICE_TABLE_PAGE_SIZE
  const status = parsed.status.trim()
  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    status: (INVOICE_STATUS_VALUES as readonly string[]).includes(status)
      ? status
      : "",
    cbteTipo: parseCbteTipo(parsed.cbteTipo),
    dateFrom: parsed.dateFrom.trim(),
    dateTo: parsed.dateTo.trim(),
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export type InvoiceArcaRow = {
  id: string
  saleId: string | null
  arcaCbteTipo: number
  tipoLabel: string
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
  impTrib: number
  monId: string
  monCotiz: number
  cae: string | null
  caeFchVto: string | null
  status: string
  arcaResultado: string | null
  arcaObservaciones: string | null
  payloadRequest: unknown
  payloadResponse: unknown
}

export type InvoiceListData = {
  invoices: InvoiceArcaRow[]
  totalCount: number
  page: number
  pageSize: number
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}
