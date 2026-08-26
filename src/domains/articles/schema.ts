import { z } from "@hono/zod-openapi"
import { okDataSchema } from "../../openapi/schemas.js"

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

const boolQuery = z.enum(["true", "false", "1", "0"]).optional().openapi({
  description: "true/1 activa el filtro; false/0 o ausente lo deja apagado.",
})

export const listArticlesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .default(DEFAULT_ARTICLE_TABLE_PAGE_SIZE)
      .openapi({
        description: "Tamaño de página. Valores útiles: 10, 25, 50, 100.",
      }),
    q: z.string().optional().default("").openapi({
      description: "Búsqueda por nombre, SKU o código de barras.",
    }),
    soloActivos: boolQuery,
    soloInactivos: boolQuery,
    conDescuento: boolQuery,
    sinDescuento: boolQuery,
    conStock: boolQuery,
    sinStock: boolQuery,
    stockNegativo: boolQuery,
    ventaSinStock: boolQuery,
    includeStock: boolQuery.openapi({
      description:
        "true/ausente consulta inventory y rellena stockOnHand. false/0 salta esa consulta, ignora conStock/sinStock/stockNegativo y deja stockOnHand=0. Default true.",
    }),
    categoryId: z.string().optional().openapi({
      description: "UUID de categoría. Si no es un UUID, se ignora.",
    }),
    itemKinds: z.string().optional().default("").openapi({
      description:
        "Tipos separados por coma: `merchandise`, `raw_material`, `supply`.",
    }),
    sort: z.enum(ARTICLE_TABLE_SORT_KEYS).optional(),
    ord: z.enum(["asc", "desc"]).optional(),
  })
  .openapi("ListArticlesQuery")

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
  includeStock: boolean
  categoryId: string
  itemKinds: ArticleItemKind[]
  sort: string | null
  ord: "asc" | "desc"
}

function queryFlagOn(value: string | undefined): boolean {
  return value === "true" || value === "1"
}

function queryFlagDefaultOn(value: string | undefined): boolean {
  return value !== "false" && value !== "0"
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

  const includeStock = queryFlagDefaultOn(parsed.includeStock)
  const stockFilters = includeStock
    ? {
        conStock: queryFlagOn(parsed.conStock),
        sinStock: queryFlagOn(parsed.sinStock),
        stockNegativo: queryFlagOn(parsed.stockNegativo),
      }
    : { conStock: false, sinStock: false, stockNegativo: false }

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    soloActivos: queryFlagOn(parsed.soloActivos),
    soloInactivos: queryFlagOn(parsed.soloInactivos),
    conDescuento: queryFlagOn(parsed.conDescuento),
    sinDescuento: queryFlagOn(parsed.sinDescuento),
    ...stockFilters,
    ventaSinStock: queryFlagOn(parsed.ventaSinStock),
    includeStock,
    categoryId: /^[0-9a-f-]{36}$/i.test(parsed.categoryId?.trim() ?? "")
      ? parsed.categoryId!.trim()
      : "",
    itemKinds: kinds,
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
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

export const costLineSchema = z
  .object({
    name: z.string().optional(),
    costUnitLabel: z.string(),
    saleUnitsPerCostUnit: z.number(),
    unitPrice: z.number(),
    supplierId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("ArticleCostLine")

export const listPriceAmountSchema = z
  .object({
    listId: z.string().uuid(),
    amount: z.number().nullable(),
  })
  .openapi("ArticleListPriceAmount")

export const upsertArticleBodySchema = z
  .object({
    name: z.string().openapi({ example: "Tomate perita" }),
    description: z.string().optional().default(""),
    imageUrl: z.string().optional().default(""),
    brand: z.string().optional().default(""),
    sku: z.string().optional().default(""),
    barcode: z.string().optional().default(""),
    salePrice: z.number(),
    iva: z.number().openapi({
      description: "Alícuota. Valores: 0, 2.5, 5, 10.5, 21, 27.",
    }),
    categoryId: z.string().uuid(),
    isActive: z.boolean(),
    discountMode: z.enum(ARTICLE_DISCOUNT_MODES).nullable(),
    discountValue: z.number().nullable(),
    allowNegativeStock: z.boolean(),
    itemKind: z.enum(ARTICLE_ITEM_KINDS),
    unitOfMeasure: z.string().openapi({
      description:
        "Unidad de medida. Valores típicos: unidad, kg, g, lt, ml, m, cm, caja. También se admite un valor custom de hasta 64 caracteres.",
    }),
    isSellable: z.boolean().optional(),
    defaultWastePct: z.number().nullable(),
    minStockLevel: z.number().nullable(),
    costs: z.array(costLineSchema).optional(),
    listPrices: z.array(listPriceAmountSchema).optional(),
    siteId: z.string().optional(),
    initialStockQuantity: z.number().nullable().optional(),
  })
  .openapi("UpsertArticle")

export const patchArticleBodySchema = upsertArticleBodySchema
  .partial()
  .openapi("PatchArticle")

export const deleteArticleBodySchema = z
  .object({
    confirmationTyped: z.string().openapi({
      description: 'Tiene que coincidir con "Eliminar {nombre}".',
      example: "Eliminar Tomate perita",
    }),
  })
  .openapi("DeleteArticle")

export const articleCostRowSchema = z
  .object({
    id: z.string(),
    popId: z.string(),
    articleId: z.string(),
    supplierId: z.string().nullable(),
    supplierName: z.string().nullable(),
    name: z.string(),
    costUnitLabel: z.string(),
    saleUnitsPerCostUnit: z.number(),
    unitPrice: z.number(),
    isActive: z.boolean(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ArticleCost")

export const articleListPriceRowSchema = z
  .object({
    listId: z.string(),
    amount: z.number(),
  })
  .openapi("ArticleListPrice")

export const articleRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    imageUrl: z.string().nullable(),
    brand: z.string(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    itemKind: z.enum(ARTICLE_ITEM_KINDS),
    unitOfMeasure: z.string(),
    isSellable: z.boolean(),
    defaultWastePct: z.number().nullable(),
    minStockLevel: z.number().nullable(),
    salePrice: z.number(),
    iva: z.number(),
    discountMode: z.enum(ARTICLE_DISCOUNT_MODES).nullable(),
    discountValue: z.number().nullable(),
    categoryId: z.string(),
    categoryName: z.string(),
    isActive: z.boolean(),
    allowNegativeStock: z.boolean(),
    stockOnHand: z.number(),
    activeCostCount: z.number(),
    costs: z.array(articleCostRowSchema),
    listPrices: z.array(articleListPriceRowSchema),
  })
  .openapi("Article")

export const articleListDataSchema = z
  .object({
    articles: z.array(articleRowSchema),
    totalCount: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    canCreate: z.boolean(),
    canPostInitialStock: z.boolean(),
    canUpdate: z.boolean(),
    canDelete: z.boolean(),
  })
  .openapi("ArticleListData")

export const articleListResponseSchema = okDataSchema(
  articleListDataSchema,
  "ArticleListResponse",
)

export const articleResponseSchema = okDataSchema(articleRowSchema, "ArticleResponse")

export const articleImageDataSchema = z
  .object({
    imageUrl: z.string(),
  })
  .openapi("ArticleImageData")

export const articleImageResponseSchema = okDataSchema(
  articleImageDataSchema,
  "ArticleImageResponse",
)

export type CostLineInput = z.infer<typeof costLineSchema>
export type ListPriceAmountInput = z.infer<typeof listPriceAmountSchema>
export type UpsertArticleBody = z.infer<typeof upsertArticleBodySchema>
export type PatchArticleBody = Partial<UpsertArticleBody>
export type ArticleCostRow = z.infer<typeof articleCostRowSchema>
export type ArticleListPriceRow = z.infer<typeof articleListPriceRowSchema>
export type ArticleRow = z.infer<typeof articleRowSchema>
export type ArticleListData = z.infer<typeof articleListDataSchema>
