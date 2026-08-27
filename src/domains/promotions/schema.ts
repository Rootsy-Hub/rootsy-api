import { z } from "zod"
import {
  PROMOTION_BENEFIT_TARGETS,
  PROMOTION_PRICING_MODES,
  PROMOTION_TYPES,
  type PromotionBenefitTarget,
  type PromotionDiscountMode,
  type PromotionOptionKind,
  type PromotionPricingMode,
  type PromotionType,
} from "./types.js"

export const PROMOTION_TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_PROMOTION_TABLE_PAGE_SIZE = 25
export const PROMOTION_TABLE_SORT_KEYS = [
  "name",
  "promotion_type",
  "valid_from",
  "valid_until",
] as const

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v == null ? undefined : v === "true" || v === "1"))

export const listPromotionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_PROMOTION_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  soloActivos: boolQuery,
  includeSlots: boolQuery,
  promotionType: z.string().optional().default(""),
  sort: z.enum(PROMOTION_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type ListPromotionsQuery = {
  page: number
  pageSize: number
  search: string
  soloActivos: boolean
  includeSlots: boolean
  promotionType: PromotionType | ""
  sort: string | null
  ord: "asc" | "desc"
}

export function toListPromotionsQuery(
  parsed: z.infer<typeof listPromotionsQuerySchema>,
): ListPromotionsQuery {
  const pageSize = PROMOTION_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof PROMOTION_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_PROMOTION_TABLE_PAGE_SIZE
  const typeRaw = parsed.promotionType.trim()
  const promotionType = (PROMOTION_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as PromotionType)
    : ""

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    soloActivos: parsed.soloActivos === true,
    includeSlots: parsed.includeSlots === true,
    promotionType,
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export const slotOptionInputSchema = z.object({
  kind: z.enum(["article", "recipe"]),
  refId: z.string().uuid(),
})

export const slotInputSchema = z.object({
  label: z.string(),
  quantity: z.number(),
  options: z.array(slotOptionInputSchema),
})

export const upsertPromotionBodySchema = z.object({
  name: z.string(),
  description: z.string().optional().default(""),
  imageUrl: z.string().optional().default(""),
  promotionType: z.enum(PROMOTION_TYPES),
  pricingMode: z.enum(PROMOTION_PRICING_MODES),
  fixedPrice: z.number().nullable(),
  discountMode: z.enum(["porcentaje", "fijo"]).nullable(),
  discountValue: z.number().nullable(),
  buyQuantity: z.number().nullable(),
  benefitQuantity: z.number().nullable(),
  benefitDiscountPct: z.number().nullable(),
  applyBenefitTo: z.enum(PROMOTION_BENEFIT_TARGETS).nullable(),
  autoApply: z.boolean(),
  showInMenu: z.boolean(),
  isActive: z.boolean(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  validTimeStart: z.string().nullable(),
  validTimeEnd: z.string().nullable(),
  scheduleDays: z.array(z.number()),
  slots: z.array(slotInputSchema),
})

export const deletePromotionBodySchema = z.object({
  confirmationTyped: z.string(),
})

export type SlotOptionInput = z.infer<typeof slotOptionInputSchema>
export type SlotInput = z.infer<typeof slotInputSchema>
export type UpsertPromotionBody = z.infer<typeof upsertPromotionBodySchema>
export type PatchPromotionBody = Partial<UpsertPromotionBody>

export type PromotionCatalogOption = {
  id: string
  name: string
  kind: PromotionOptionKind
  salePrice: number
}

export type PromotionSlotOptionRow = {
  id: string
  kind: PromotionOptionKind
  refId: string
  name: string
  salePrice: number
  iva: number
}

export type PromotionSlotRow = {
  id: string
  label: string
  quantity: number
  sortOrder: number
  options: PromotionSlotOptionRow[]
}

export type PromotionRow = {
  id: string
  name: string
  description: string
  imageUrl: string | null
  promotionType: PromotionType
  pricingMode: PromotionPricingMode
  fixedPrice: number | null
  discountMode: PromotionDiscountMode | null
  discountValue: number | null
  buyQuantity: number | null
  benefitQuantity: number | null
  benefitDiscountPct: number | null
  applyBenefitTo: PromotionBenefitTarget | null
  autoApply: boolean
  showInMenu: boolean
  isActive: boolean
  sortOrder: number
  validFrom: string | null
  validUntil: string | null
  validTimeStart: string | null
  validTimeEnd: string | null
  scheduleDays: number[]
  slotCount: number
  optionCount: number
  pricingSummary: string
  scheduleSummary: string
}

export type PromotionDetail = PromotionRow & {
  slots: PromotionSlotRow[]
}

export type PromotionListRow = PromotionRow & {
  slots?: PromotionSlotRow[]
}

export type PromotionListData = {
  promotions: PromotionListRow[]
  totalCount: number
  page: number
  pageSize: number
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}
