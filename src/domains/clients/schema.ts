import { z } from "zod"

export const CLIENT_TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_CLIENT_TABLE_PAGE_SIZE = 25
export const CLIENT_TABLE_SORT_KEYS = [
  "name",
  "email",
  "phone",
  "tax_id",
  "iva",
] as const

export const CLIENT_IVA_CONDITION_VALUES = [
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "consumidor_final",
  "exento",
  "no_categorizado",
] as const

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v == null ? undefined : v === "true" || v === "1"))

export const listClientsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_CLIENT_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  soloActivos: boolQuery,
  withEmail: boolQuery,
  withTaxId: boolQuery,
  sort: z.enum(CLIENT_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type ListClientsQuery = {
  page: number
  pageSize: number
  search: string
  soloActivos: boolean
  withEmail: boolean
  withTaxId: boolean
  sort: string | null
  ord: "asc" | "desc"
}

export function toListClientsQuery(
  parsed: z.infer<typeof listClientsQuerySchema>,
): ListClientsQuery {
  const pageSize = CLIENT_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof CLIENT_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_CLIENT_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    soloActivos: parsed.soloActivos === true,
    withEmail: parsed.withEmail === true,
    withTaxId: parsed.withTaxId === true,
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export const upsertClientBodySchema = z.object({
  name: z.string(),
  email: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  taxId: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  ivaCondition: z.string().optional().default(""),
  addressLine: z.string().optional().default(""),
  defaultInvoiceTypeLabel: z.string().optional().default(""),
  isActive: z.boolean(),
  currentAccountEnabled: z.boolean(),
  currentAccountCreditLimit: z.string().optional().default(""),
  currentAccountTermDays: z.string().optional().default(""),
})

export const deleteClientBodySchema = z.object({
  confirmationTyped: z.string(),
})

export type UpsertClientBody = z.infer<typeof upsertClientBodySchema>
export type PatchClientBody = Partial<UpsertClientBody>

export type ClientRow = {
  id: string
  name: string
  email: string
  phone: string
  taxId: string
  notes: string
  ivaCondition: string | null
  addressLine: string
  defaultInvoiceTypeLabel: string | null
  isActive: boolean
  currentAccountEnabled: boolean
  currentAccountCreditLimit: number | null
  currentAccountTermDays: number
  lastSaleAt: string | null
  completedSalesCount: number
  totalSpentArs: number
}

export type ClientListData = {
  clients: ClientRow[]
  totalCount: number
  page: number
  pageSize: number
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}
