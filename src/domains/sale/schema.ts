import { z } from "@hono/zod-openapi"
import { okDataSchema } from "../../openapi/schemas.js"
import type { TreasuryPaymentContext } from "../expenses/schema.js"

export const SALE_CATALOG_PAGE_SIZE = 48
export const DEFAULT_SALE_SITE_ID = "arg"

const optionalUuid = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined
    return z.string().uuid().safeParse(value).success ? value : undefined
  })
  .openapi({ type: "string", format: "uuid" })

export const saleCatalogItemsQuerySchema = z
  .object({
    section: z.string().optional().default("products"),
    categoryId: optionalUuid,
    categoryIds: z
      .string()
      .optional()
      .transform((value) => {
        if (!value) return undefined
        const ids = value
          .split(",")
          .map((id) => id.trim())
          .filter((id) => z.string().uuid().safeParse(id).success)
        return ids.length > 0 ? ids : undefined
      })
      .openapi({
        type: "string",
        description: "UUIDs de categoría separados por coma.",
      }),
    search: z.string().optional().default(""),
    priceListId: optionalUuid,
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .openapi("SaleCatalogItemsQuery")

export const saleCatalogArticlesQuerySchema = z
  .object({
    ids: z.string().min(1).openapi({
      description: "UUIDs de artículo separados por coma.",
    }),
    priceListId: optionalUuid,
  })
  .openapi("SaleCatalogArticlesQuery")

export const saleCatalogScanQuerySchema = z
  .object({
    q: z.string().min(1),
    priceListId: optionalUuid,
  })
  .openapi("SaleCatalogScanQuery")

export type SaleCatalogItemsQuery = z.infer<typeof saleCatalogItemsQuerySchema>

const discountModeSchema = z.enum(["porcentaje", "fijo"]).nullable()

export const saleCatalogCategorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    sortOrder: z.number(),
  })
  .openapi("SaleCatalogCategory")

export const saleCatalogCategorySectionSchema = z
  .object({
    id: z.enum(["recipes", "products", "promotions"]),
    label: z.string(),
    categories: z.array(saleCatalogCategorySchema),
  })
  .openapi("SaleCatalogCategorySection")

export const saleCatalogArticleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    salePrice: z.number(),
    originalSalePrice: z.number().optional(),
    discountMode: discountModeSchema.optional(),
    discountValue: z.number().nullable().optional(),
    iva: z.number(),
    categoryId: z.string(),
    categoryName: z.string(),
    unitOfMeasure: z.string(),
    imageUrl: z.string().nullable(),
    barcode: z.string().nullable().optional(),
  })
  .openapi("SaleCatalogArticle")

export const saleOpenCashSessionSchema = z
  .object({
    sessionId: z.string(),
    cashRegisterId: z.string(),
    registerName: z.string(),
    cashTreasuryAccountId: z.string(),
  })
  .openapi("SaleOpenCashSession")

export const salePromotionOptionSchema = z
  .object({
    kind: z.enum(["article", "recipe"]),
    refId: z.string(),
    name: z.string(),
    salePrice: z.number(),
    iva: z.number(),
  })
  .openapi("SalePromotionOption")

export const salePromotionSlotSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    quantity: z.number(),
    options: z.array(salePromotionOptionSchema),
  })
  .openapi("SalePromotionSlot")

export const salePromotionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    imageUrl: z.string().nullable(),
    promotionType: z.enum(["combo", "quantity_deal"]),
    pricingMode: z.enum(["fixed_total", "percent_off", "fixed_off"]),
    fixedPrice: z.number().nullable(),
    discountMode: discountModeSchema,
    discountValue: z.number().nullable(),
    buyQuantity: z.number().nullable(),
    benefitQuantity: z.number().nullable(),
    benefitDiscountPct: z.number().nullable(),
    applyBenefitTo: z.enum(["cheapest", "most_expensive"]).nullable(),
    autoApply: z.boolean(),
    showInMenu: z.boolean(),
    slots: z.array(salePromotionSlotSchema),
    pricingLabel: z.string(),
  })
  .openapi("SalePromotion")

export const saleComprobanteOptionSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("none"),
      label: z.literal("Sin comprobante"),
    }),
    z.object({
      kind: z.literal("internal"),
      label: z.literal("Recibo X"),
    }),
    z.object({
      kind: z.literal("arca"),
      label: z.string(),
      arcaCbteTipo: z.number(),
      arcaRegimen: z.enum(["fe_general", "fce_mipyme"]),
    }),
  ])
  .openapi("SaleComprobanteOption")

export const saleCatalogDataSchema = z
  .object({
    popName: z.string(),
    categories: z.array(saleCatalogCategorySchema),
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
  .openapi("SaleCatalogData")

export const saleCatalogItemsPageSchema = z
  .object({
    items: z.array(saleCatalogArticleSchema),
    nextOffset: z.number().nullable(),
  })
  .openapi("SaleCatalogItemsPage")

export const saleComprobanteEmitterSchema = z
  .object({
    tradeName: z.string(),
    razonSocial: z.string(),
    address: z.string().nullable(),
    cuit: z.string().nullable(),
    ingresosBrutos: z.string().nullable(),
    inicioActividades: z.string().nullable(),
    phone: z.string().nullable(),
    arcaPtoVta: z.number().nullable(),
    ivaCondition: z.enum(["responsable_inscripto", "monotributo"]),
    ivaConditionLabel: z.string(),
    hasValidFiscalCuit: z.boolean(),
  })
  .openapi("SaleComprobanteEmitter")

export const saleComprobantesDataSchema = z
  .object({
    invoiceTypeSiteId: z.string(),
    hasValidFiscalCuit: z.boolean(),
    emisorIvaCondition: z.enum(["responsable_inscripto", "monotributo"]),
    options: z.array(saleComprobanteOptionSchema),
    emitter: saleComprobanteEmitterSchema,
  })
  .openapi("SaleComprobantesData")

export const salePaymentPickOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .openapi("SalePaymentPickOption")

export const salePaymentContextDataSchema = z
  .object({
    defaultCashTreasuryAccountId: z.string().nullable(),
    cashTreasuryAccounts: z.array(salePaymentPickOptionSchema),
    bankTreasuryAccounts: z.array(salePaymentPickOptionSchema),
    posTreasuryAccounts: z.array(salePaymentPickOptionSchema),
    payTreasuryAccounts: z.array(salePaymentPickOptionSchema),
    checkReceivableTreasuryAccountId: z.string().nullable(),
    checkPayableTreasuryAccountId: z.string().nullable(),
  })
  .openapi("SalePaymentContext")

export const saleCatalogResponseSchema = okDataSchema(
  saleCatalogDataSchema,
  "SaleCatalogResponse",
)
export const saleCatalogItemsResponseSchema = okDataSchema(
  saleCatalogItemsPageSchema,
  "SaleCatalogItemsResponse",
)
export const saleCatalogArticlesResponseSchema = okDataSchema(
  z.array(saleCatalogArticleSchema),
  "SaleCatalogArticlesResponse",
)
export const saleCatalogScanResponseSchema = okDataSchema(
  saleCatalogArticleSchema.nullable(),
  "SaleCatalogScanResponse",
)
export const salePaymentContextResponseSchema = okDataSchema(
  salePaymentContextDataSchema,
  "SalePaymentContextResponse",
)
export const saleComprobantesResponseSchema = okDataSchema(
  saleComprobantesDataSchema,
  "SaleComprobantesResponse",
)

export type SaleCatalogCategory = z.infer<typeof saleCatalogCategorySchema>
export type SaleCatalogCategorySection = z.infer<
  typeof saleCatalogCategorySectionSchema
>
export type SaleCatalogArticle = z.infer<typeof saleCatalogArticleSchema>
export type SaleOpenCashSession = z.infer<typeof saleOpenCashSessionSchema>
export type SalePromotionOption = z.infer<typeof salePromotionOptionSchema>
export type SalePromotionSlot = z.infer<typeof salePromotionSlotSchema>
export type SalePromotion = z.infer<typeof salePromotionSchema>
export type SaleComprobanteOption = z.infer<typeof saleComprobanteOptionSchema>
export type SaleCatalogData = z.infer<typeof saleCatalogDataSchema>
export type SaleCatalogItemsPage = z.infer<typeof saleCatalogItemsPageSchema>
export type SaleComprobantesData = z.infer<typeof saleComprobantesDataSchema>

export type { TreasuryPaymentContext }
