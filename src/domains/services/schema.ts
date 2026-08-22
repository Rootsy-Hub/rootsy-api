import { z } from "zod"
import {
  SERVICE_BILLING_PERIODS,
  SERVICE_DISCOUNT_MODES,
  SERVICE_LATE_INTEREST_TYPES,
  SERVICE_PAYMENT_TIMINGS,
  type ServiceArticleItemKind,
  type ServiceBillingPeriod,
  type ServiceDetailsGrid,
  type ServiceDiscountMode,
  type ServiceLateInterestType,
  type ServicePaymentTiming,
} from "./catalog.js"

export const SERVICE_TABLE_PAGE_SIZES = [10, 25, 50] as const
export const DEFAULT_SERVICE_TABLE_PAGE_SIZE = 25
export const SERVICE_TABLE_SORT_KEYS = [
  "name",
  "default_price",
  "billing_period",
] as const
export const SERVICE_ARTICLE_SEARCH_LIMIT = 5

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v == null ? undefined : v === "true" || v === "1"))

export const listServicesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_SERVICE_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  soloActivos: boolQuery,
  categoryId: z.string().optional(),
  sort: z.enum(SERVICE_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type ListServicesQuery = {
  page: number
  pageSize: number
  search: string
  soloActivos: boolean
  categoryId: string
  sort: string | null
  ord: "asc" | "desc"
}

export function toListServicesQuery(
  parsed: z.infer<typeof listServicesQuerySchema>,
): ListServicesQuery {
  const pageSize = SERVICE_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof SERVICE_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_SERVICE_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    soloActivos: parsed.soloActivos === true,
    categoryId: /^[0-9a-f-]{36}$/i.test(parsed.categoryId?.trim() ?? "")
      ? parsed.categoryId!.trim()
      : "",
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export const listServiceArticlesQuerySchema = z.object({
  q: z.string().optional().default(""),
  exclude: z.string().optional().default(""),
  limit: z.coerce.number().int().min(1).max(20).optional(),
})

export const serviceArticleInputSchema = z.object({
  articleId: z.string().uuid(),
  quantity: z.number(),
})

export const serviceAddonInputSchema = z.object({
  name: z.string(),
  price: z.number(),
  articles: z.array(serviceArticleInputSchema).optional().default([]),
})

export const serviceDetailsGridSchema = z.object({
  columns: z.array(z.string()).default([]),
  rows: z.array(z.array(z.string())).default([]),
})

export const upsertServiceBodySchema = z.object({
  name: z.string(),
  description: z.string().optional().default(""),
  categoryId: z.string().uuid(),
  imageUrl: z.string().optional().default(""),
  defaultPrice: z.number(),
  billingPeriod: z.enum(SERVICE_BILLING_PERIODS),
  billingPeriodLabel: z.string().optional().default(""),
  detailsGrid: serviceDetailsGridSchema.optional().default({
    columns: [],
    rows: [],
  }),
  contractText: z.string().optional().default(""),
  paymentTiming: z.enum(SERVICE_PAYMENT_TIMINGS),
  dueDaysAfter: z.number(),
  lateInterestType: z.enum(SERVICE_LATE_INTEREST_TYPES),
  lateInterestValue: z.number().nullable(),
  discountMode: z.enum(SERVICE_DISCOUNT_MODES),
  discountValue: z.number().nullable(),
  articles: z.array(serviceArticleInputSchema).optional().default([]),
  addons: z.array(serviceAddonInputSchema).optional().default([]),
  isActive: z.boolean(),
})

export const deleteServiceBodySchema = z.object({
  confirmationTyped: z.string(),
})

export type ServiceArticleInput = z.infer<typeof serviceArticleInputSchema>
export type ServiceAddonInput = z.infer<typeof serviceAddonInputSchema>
export type UpsertServiceBody = z.infer<typeof upsertServiceBodySchema>

export type ServiceArticleOption = {
  id: string
  name: string
  itemKind: ServiceArticleItemKind
  unitOfMeasure: string
}

export type ServiceArticleRow = ServiceArticleInput & {
  id: string
  articleName: string
  unitOfMeasure: string
  itemKind: ServiceArticleItemKind
}

export type ServiceAddonRow = {
  id: string
  name: string
  price: number
  sortOrder: number
  articles: ServiceArticleRow[]
}

export type ServiceRow = {
  id: string
  name: string
  description: string
  imageUrl: string | null
  categoryId: string | null
  categoryName: string
  defaultPrice: number
  billingPeriod: ServiceBillingPeriod
  billingPeriodLabel: string | null
  billingPeriodDisplay: string
  detailCount: number
  contractHasText: boolean
  articleCount: number
  isActive: boolean
}

export type ServiceDetail = ServiceRow & {
  detailsGrid: ServiceDetailsGrid
  contractText: string
  paymentTiming: ServicePaymentTiming
  dueDaysAfter: number
  lateInterestType: ServiceLateInterestType
  lateInterestValue: number | null
  discountMode: ServiceDiscountMode
  discountValue: number | null
  articles: ServiceArticleRow[]
  addons: ServiceAddonRow[]
}

export type ServiceListData = {
  services: ServiceRow[]
  totalCount: number
  page: number
  pageSize: number
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}
