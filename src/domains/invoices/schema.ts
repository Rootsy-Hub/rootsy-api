import { z } from "@hono/zod-openapi"
import { okDataSchema } from "../../openapi/schemas.js"

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

export const listInvoicesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .default(DEFAULT_INVOICE_TABLE_PAGE_SIZE)
      .openapi({
        description: "Tamaño de página. Valores útiles: 10, 25, 50, 100.",
      }),
    q: z.string().optional().default("").openapi({
      description: "Búsqueda por receptor, CAE o número de comprobante.",
    }),
    status: z.string().optional().default("").openapi({
      description:
        "draft, pending_afip, authorized, rejected o cancelled. Otro valor se ignora.",
    }),
    cbteTipo: z.string().optional().default("").openapi({
      description:
        "`recibo_x` / `x` para recibos X, o el entero de tipo ARCA (p. ej. 1, 6, 11). Otro valor se ignora.",
    }),
    dateFrom: z.string().optional().default("").openapi({
      description: "Fecha desde (inclusive), `YYYY-MM-DD`.",
    }),
    dateTo: z.string().optional().default("").openapi({
      description: "Fecha hasta (inclusive), `YYYY-MM-DD`.",
    }),
    sort: z.enum(INVOICE_TABLE_SORT_KEYS).optional(),
    ord: z.enum(["asc", "desc"]).optional(),
  })
  .openapi("ListInvoicesQuery")

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

export const invoiceArcaRowSchema = z
  .object({
    id: z.string(),
    saleId: z.string().nullable(),
    arcaCbteTipo: z.number(),
    tipoLabel: z.string(),
    arcaRegimen: z.string(),
    ptoVta: z.number(),
    cbteNro: z.string(),
    cbteFch: z.string(),
    docTipo: z.number().nullable(),
    docNro: z.string(),
    receptorRazonSocial: z.string(),
    impTotal: z.number(),
    impNeto: z.number(),
    impIva: z.number(),
    impTrib: z.number(),
    monId: z.string(),
    monCotiz: z.number(),
    cae: z.string().nullable(),
    caeFchVto: z.string().nullable(),
    status: z.string(),
    arcaResultado: z.string().nullable(),
    arcaObservaciones: z.string().nullable(),
    payloadRequest: z.unknown().openapi({
      description: "Payload enviado a ARCA.",
    }),
    payloadResponse: z.unknown().openapi({
      description: "Respuesta cruda de ARCA.",
    }),
  })
  .openapi("Invoice")

export const invoiceListDataSchema = z
  .object({
    invoices: z.array(invoiceArcaRowSchema),
    totalCount: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    canCreate: z.boolean(),
    canUpdate: z.boolean(),
    canDelete: z.boolean(),
  })
  .openapi("InvoiceListData")

export const invoiceListResponseSchema = okDataSchema(
  invoiceListDataSchema,
  "InvoiceListResponse",
)

export type InvoiceArcaRow = z.infer<typeof invoiceArcaRowSchema>
export type InvoiceListData = z.infer<typeof invoiceListDataSchema>
