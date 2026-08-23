import { z } from "zod"
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

export const saleCatalogItemsQuerySchema = z.object({
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
    }),
  search: z.string().optional().default(""),
  priceListId: optionalUuid,
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export const saleCatalogArticlesQuerySchema = z.object({
  ids: z.string().min(1),
  priceListId: optionalUuid,
})

export const saleCatalogScanQuerySchema = z.object({
  q: z.string().min(1),
  priceListId: optionalUuid,
})

export type SaleCatalogItemsQuery = z.infer<typeof saleCatalogItemsQuerySchema>

export type SaleCatalogCategory = {
  id: string
  name: string
  sortOrder: number
}

export type SaleCatalogCategorySection = {
  id: "recipes" | "products" | "promotions"
  label: string
  categories: SaleCatalogCategory[]
}

export type SaleCatalogArticle = {
  id: string
  name: string
  description: string
  salePrice: number
  originalSalePrice?: number
  discountMode?: "porcentaje" | "fijo" | null
  discountValue?: number | null
  iva: number
  categoryId: string
  categoryName: string
  unitOfMeasure: string
  imageUrl: string | null
  barcode?: string | null
}

export type SaleOpenCashSession = {
  sessionId: string
  cashRegisterId: string
  registerName: string
  cashTreasuryAccountId: string
}

export type SalePromotionOption = {
  kind: "article" | "recipe"
  refId: string
  name: string
  salePrice: number
  iva: number
}

export type SalePromotionSlot = {
  id: string
  label: string
  quantity: number
  options: SalePromotionOption[]
}

export type SalePromotion = {
  id: string
  name: string
  description: string
  imageUrl: string | null
  promotionType: "combo" | "quantity_deal"
  pricingMode: "fixed_total" | "percent_off" | "fixed_off"
  fixedPrice: number | null
  discountMode: "porcentaje" | "fijo" | null
  discountValue: number | null
  buyQuantity: number | null
  benefitQuantity: number | null
  benefitDiscountPct: number | null
  applyBenefitTo: "cheapest" | "most_expensive" | null
  autoApply: boolean
  showInMenu: boolean
  slots: SalePromotionSlot[]
  pricingLabel: string
}

export type SaleComprobanteOption =
  | { kind: "none"; label: "Sin comprobante" }
  | { kind: "internal"; label: "Recibo X" }
  | {
      kind: "arca"
      label: string
      arcaCbteTipo: number
      arcaRegimen: "fe_general" | "fce_mipyme"
    }

export type SaleCatalogData = {
  popName: string
  categories: SaleCatalogCategory[]
  categorySections: SaleCatalogCategorySection[]
  promotions: SalePromotion[]
  quantityDeals: SalePromotion[]
  canReadClients: boolean
  canReadPaymentMethods: boolean
  canCreateSale: boolean
  canReadCashRegisters: boolean
  openCashSession: SaleOpenCashSession | null
  invoiceTypeSiteId: string
}

export type SaleCatalogItemsPage = {
  items: SaleCatalogArticle[]
  nextOffset: number | null
}

export type SaleComprobantesData = {
  invoiceTypeSiteId: string
  hasValidFiscalCuit: boolean
  emisorIvaCondition: "responsable_inscripto" | "monotributo"
  options: SaleComprobanteOption[]
}

export type { TreasuryPaymentContext }
