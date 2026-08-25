import { z } from "@hono/zod-openapi"
import { okDataSchema } from "../../openapi/schemas.js"
import {
  DEFAULT_SALE_SITE_ID,
  SALE_CATALOG_PAGE_SIZE,
  saleCatalogArticleSchema,
  saleCatalogCategorySectionSchema,
  saleOpenCashSessionSchema,
  salePromotionSchema,
} from "../sale/schema.js"

export { DEFAULT_SALE_SITE_ID, SALE_CATALOG_PAGE_SIZE }

const optionalUuid = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined
    return z.string().uuid().safeParse(value).success ? value : undefined
  })
  .openapi({ type: "string", format: "uuid" })

export const menuCatalogItemsQuerySchema = z
  .object({
    section: z.string().optional().default("products").openapi({
      description:
        "`products`, `recipes`, `promotions`, `all` o `discounts`.",
    }),
    categoryId: optionalUuid,
    search: z.string().optional().default(""),
    priceListId: optionalUuid,
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .openapi("MenuCatalogItemsQuery")

export const menuCatalogItemsByIdsQuerySchema = z
  .object({
    articleIds: z.string().optional().default("").openapi({
      description: "UUIDs de artículo separados por coma.",
    }),
    recipeIds: z.string().optional().default("").openapi({
      description: "UUIDs de receta separados por coma.",
    }),
    priceListId: optionalUuid,
  })
  .openapi("MenuCatalogItemsByIdsQuery")

export const menuCatalogScanQuerySchema = z
  .object({
    q: z.string().min(1),
    priceListId: optionalUuid,
  })
  .openapi("MenuCatalogScanQuery")

export type MenuCatalogItemsQuery = z.infer<typeof menuCatalogItemsQuerySchema>

export const menuCatalogRecipeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    salePrice: z.number(),
    iva: z.number(),
    categoryId: z.string(),
    categoryName: z.string(),
    imageUrl: z.string().nullable(),
    stationId: z.string().nullable(),
  })
  .openapi("MenuCatalogRecipe")

export const menuCatalogDataSchema = z
  .object({
    popName: z.string(),
    categorySections: z.array(saleCatalogCategorySectionSchema),
    promotions: z.array(salePromotionSchema),
    quantityDeals: z.array(salePromotionSchema),
    canReadClients: z.boolean(),
    canReadPaymentMethods: z.boolean(),
    canCreateSale: z.boolean(),
    canReadCashRegisters: z.boolean(),
    openCashSession: saleOpenCashSessionSchema.nullable(),
    invoiceTypeSiteId: z.string(),
  })
  .openapi("MenuCatalogData")

export const menuCatalogItemsPageSchema = z
  .object({
    articles: z.array(saleCatalogArticleSchema),
    recipes: z.array(menuCatalogRecipeSchema),
    nextOffset: z.number().nullable(),
  })
  .openapi("MenuCatalogItemsPage")

export const menuCatalogItemsByIdsDataSchema = z
  .object({
    articles: z.array(saleCatalogArticleSchema),
    recipes: z.array(menuCatalogRecipeSchema),
  })
  .openapi("MenuCatalogItemsByIdsData")

export const menuCatalogScanDataSchema = z
  .object({
    article: saleCatalogArticleSchema.nullable(),
    recipe: menuCatalogRecipeSchema.nullable(),
  })
  .openapi("MenuCatalogScanData")

export const menuCatalogResponseSchema = okDataSchema(
  menuCatalogDataSchema,
  "MenuCatalogResponse",
)
export const menuCatalogItemsResponseSchema = okDataSchema(
  menuCatalogItemsPageSchema,
  "MenuCatalogItemsResponse",
)
export const menuCatalogItemsByIdsResponseSchema = okDataSchema(
  menuCatalogItemsByIdsDataSchema,
  "MenuCatalogItemsByIdsResponse",
)
export const menuCatalogScanResponseSchema = okDataSchema(
  menuCatalogScanDataSchema,
  "MenuCatalogScanResponse",
)

export type MenuCatalogRecipe = z.infer<typeof menuCatalogRecipeSchema>
export type MenuCatalogData = z.infer<typeof menuCatalogDataSchema>
export type MenuCatalogItemsPage = z.infer<typeof menuCatalogItemsPageSchema>

export type MenuCatalogCaps = {
  canReadClients: boolean
  canReadPaymentMethods: boolean
  canCreateSale: boolean
  canReadCashRegisters: boolean
}

export type {
  SaleCatalogArticle,
  SaleCatalogCategory,
  SaleCatalogCategorySection,
} from "../sale/schema.js"
