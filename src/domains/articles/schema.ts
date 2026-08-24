import { z } from "zod"

export const ARTICLE_ITEM_KINDS = [
  "merchandise",
  "raw_material",
  "supply",
] as const

export const ARTICLE_DISCOUNT_MODES = ["porcentaje", "fijo"] as const

export const ARTICLE_TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_ARTICLE_TABLE_PAGE_SIZE = 25
export const ARTICLE_TABLE_SORT_KEYS = ["name", "sale_price"] as const

export type ArticleItemKind = (typeof ARTICLE_ITEM_KINDS)[number]
export type ArticleDiscountMode = (typeof ARTICLE_DISCOUNT_MODES)[number]

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v == null ? undefined : v === "true" || v === "1"))

export const listArticlesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_ARTICLE_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  soloActivos: boolQuery,
  soloInactivos: boolQuery,
  conDescuento: boolQuery,
  sinDescuento: boolQuery,
  conStock: boolQuery,
  sinStock: boolQuery,
  stockNegativo: boolQuery,
  ventaSinStock: boolQuery,
  categoryId: z.string().optional(),
  itemKinds: z.string().optional().default(""),
  sort: z.enum(ARTICLE_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type ListArticlesQuery = {
  page: number
  pageSize: number
  search: string
  soloActivos: boolean
  soloInactivos: boolean
  conDescuento: boolean
  sinDescuento: boolean
  conStock: boolean
  sinStock: boolean
  stockNegativo: boolean
  ventaSinStock: boolean
  categoryId: string
  itemKinds: ArticleItemKind[]
  sort: string | null
  ord: "asc" | "desc"
}

export function toListArticlesQuery(
  parsed: z.infer<typeof listArticlesQuerySchema>,
): ListArticlesQuery {
  const kinds: ArticleItemKind[] = []
  for (const part of parsed.itemKinds.split(",")) {
    const token = part.trim()
    if (
      (ARTICLE_ITEM_KINDS as readonly string[]).includes(token) &&
      !kinds.includes(token as ArticleItemKind)
    ) {
      kinds.push(token as ArticleItemKind)
    }
  }
  const pageSize = ARTICLE_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof ARTICLE_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_ARTICLE_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    soloActivos: parsed.soloActivos === true,
    soloInactivos: parsed.soloInactivos === true,
    conDescuento: parsed.conDescuento === true,
    sinDescuento: parsed.sinDescuento === true,
    conStock: parsed.conStock === true,
    sinStock: parsed.sinStock === true,
    stockNegativo: parsed.stockNegativo === true,
    ventaSinStock: parsed.ventaSinStock === true,
    categoryId: /^[0-9a-f-]{36}$/i.test(parsed.categoryId?.trim() ?? "")
      ? parsed.categoryId!.trim()
      : "",
    itemKinds: kinds,
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export type ArticleCostRow = {
  id: string
  popId: string
  articleId: string
  supplierId: string | null
  supplierName: string | null
  name: string
  costUnitLabel: string
  saleUnitsPerCostUnit: number
  unitPrice: number
  isActive: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type ArticleListPriceRow = {
  listId: string
  amount: number
}

export type ArticleRow = {
  id: string
  name: string
  description: string
  imageUrl: string | null
  brand: string
  sku: string | null
  barcode: string | null
  itemKind: ArticleItemKind
  unitOfMeasure: string
  isSellable: boolean
  defaultWastePct: number | null
  minStockLevel: number | null
  salePrice: number
  iva: number
  discountMode: ArticleDiscountMode | null
  discountValue: number | null
  categoryId: string
  categoryName: string
  isActive: boolean
  allowNegativeStock: boolean
  stockOnHand: number
  activeCostCount: number
  costs: ArticleCostRow[]
  listPrices: ArticleListPriceRow[]
}

export type ArticleListData = {
  articles: ArticleRow[]
  totalCount: number
  page: number
  pageSize: number
  canCreate: boolean
  canPostInitialStock: boolean
  canUpdate: boolean
  canDelete: boolean
}

export const UNIT_OF_MEASURE_VALUES = [
  "unidad",
  "kg",
  "g",
  "lt",
  "ml",
  "m",
  "cm",
  "caja",
] as const

export const MAX_CUSTOM_UNIT_OF_MEASURE_LENGTH = 64

export const ARTICLE_IVA_RATES = [0, 2.5, 5, 10.5, 21, 27] as const

export const costLineSchema = z.object({
  name: z.string().optional(),
  costUnitLabel: z.string(),
  saleUnitsPerCostUnit: z.number(),
  unitPrice: z.number(),
  supplierId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
})

export const listPriceAmountSchema = z.object({
  listId: z.string().uuid(),
  amount: z.number().nullable(),
})

export const upsertArticleBodySchema = z.object({
  name: z.string(),
  description: z.string().optional().default(""),
  imageUrl: z.string().optional().default(""),
  brand: z.string().optional().default(""),
  sku: z.string().optional().default(""),
  barcode: z.string().optional().default(""),
  salePrice: z.number(),
  iva: z.number(),
  categoryId: z.string().uuid(),
  isActive: z.boolean(),
  discountMode: z.enum(ARTICLE_DISCOUNT_MODES).nullable(),
  discountValue: z.number().nullable(),
  allowNegativeStock: z.boolean(),
  itemKind: z.enum(ARTICLE_ITEM_KINDS),
  unitOfMeasure: z.string(),
  isSellable: z.boolean().optional(),
  defaultWastePct: z.number().nullable(),
  minStockLevel: z.number().nullable(),
  costs: z.array(costLineSchema).optional(),
  listPrices: z.array(listPriceAmountSchema).optional(),
  siteId: z.string().optional(),
  initialStockQuantity: z.number().nullable().optional(),
})

export const deleteArticleBodySchema = z.object({
  confirmationTyped: z.string(),
})

export type CostLineInput = z.infer<typeof costLineSchema>
export type ListPriceAmountInput = z.infer<typeof listPriceAmountSchema>
export type UpsertArticleBody = z.infer<typeof upsertArticleBodySchema>
export type PatchArticleBody = Partial<UpsertArticleBody>
