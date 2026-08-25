import { z } from "@hono/zod-openapi"
import { popIdParamSchema } from "../../openapi/schemas.js"

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

const boolQuery = z.enum(["true", "false", "1", "0"]).optional().openapi({
  description: "true/1 activa el filtro; false/0 o ausente lo deja apagado.",
})

export const listClientsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().default(DEFAULT_CLIENT_TABLE_PAGE_SIZE),
    q: z.string().optional().default(""),
    soloActivos: boolQuery,
    withEmail: boolQuery,
    withTaxId: boolQuery,
    sort: z.enum(CLIENT_TABLE_SORT_KEYS).optional(),
    ord: z.enum(["asc", "desc"]).optional(),
  })
  .openapi("ListClientsQuery")

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

function queryFlagOn(value: string | undefined): boolean {
  return value === "true" || value === "1"
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
    soloActivos: queryFlagOn(parsed.soloActivos),
    withEmail: queryFlagOn(parsed.withEmail),
    withTaxId: queryFlagOn(parsed.withTaxId),
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export const upsertClientBodySchema = z
  .object({
    name: z.string().openapi({ example: "Juan Pérez" }),
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
  .openapi("UpsertClient")

export const patchClientBodySchema = upsertClientBodySchema
  .partial()
  .openapi("PatchClient")

export const deleteClientBodySchema = z
  .object({
    confirmationTyped: z.string().openapi({
      description: 'Tiene que coincidir con "Eliminar {nombre}".',
      example: "Eliminar Juan Pérez",
    }),
  })
  .openapi("DeleteClient")

export const clientIdParamSchema = popIdParamSchema.extend({
  clientId: z.string().uuid().openapi({
    param: { name: "clientId", in: "path" },
    example: "32851b60-7fc4-4a00-87b5-27dab1739a4a",
  }),
})

export const clientRowSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    taxId: z.string(),
    notes: z.string(),
    ivaCondition: z.string().nullable(),
    addressLine: z.string(),
    defaultInvoiceTypeLabel: z.string().nullable(),
    isActive: z.boolean(),
    currentAccountEnabled: z.boolean(),
    currentAccountCreditLimit: z.number().nullable(),
    currentAccountTermDays: z.number(),
    lastSaleAt: z.string().nullable(),
    completedSalesCount: z.number(),
    totalSpentArs: z.number(),
  })
  .openapi("Client")

export const clientListDataSchema = z
  .object({
    clients: z.array(clientRowSchema),
    totalCount: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    canCreate: z.boolean(),
    canUpdate: z.boolean(),
    canDelete: z.boolean(),
  })
  .openapi("ClientListData")

export const clientListResponseSchema = z
  .object({
    success: z.literal(true),
    data: clientListDataSchema,
  })
  .openapi("ClientListResponse")

export const createClientResponseSchema = z
  .object({
    success: z.literal(true),
    id: z.string().uuid(),
  })
  .openapi("CreateClientResponse")

export type UpsertClientBody = z.infer<typeof upsertClientBodySchema>
export type PatchClientBody = Partial<UpsertClientBody>
export type ClientRow = z.infer<typeof clientRowSchema>
export type ClientListData = z.infer<typeof clientListDataSchema>
