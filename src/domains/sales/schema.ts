import { z } from "@hono/zod-openapi"
import { okDataSchema } from "../../openapi/schemas.js"
import { OPERATION_PAYMENT_KINDS } from "../current-accounts/schema.js"

export const SALE_DISCOUNT_MODES = ["porcentaje", "fijo"] as const
export const CLIENT_IVA_CONDITIONS = [
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "consumidor_final",
  "exento",
  "no_categorizado",
] as const

const uuid = z.string().uuid()

export const saleLineSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    unitPrice: z.number().nonnegative(),
    iva: z.number().min(0).max(100).optional(),
    catalogDiscountMode: z.enum(SALE_DISCOUNT_MODES).nullable().optional(),
    catalogDiscountValue: z.number().nonnegative().nullable().optional(),
    listTotal: z.number().nonnegative().optional(),
  })
  .openapi("SaleLineSnapshot")

export const salePromotionSelectionSchema = z
  .object({
    slotId: uuid,
    kind: z.enum(["article", "recipe"]),
    refId: uuid,
    name: z.string().trim().min(1).max(200).optional(),
    slotLabel: z.string().optional(),
    listUnitPrice: z.number().nonnegative().optional(),
    slotQuantity: z.number().positive().optional(),
    iva: z.number().min(0).max(100).optional(),
  })
  .openapi("SalePromotionSelection")

export const createSaleLineSchema = z
  .object({
    articleId: uuid.optional(),
    recipeId: uuid.optional(),
    promotionId: uuid.optional(),
    quantity: z.number().positive(),
    snapshot: saleLineSnapshotSchema,
    itemDiscountMode: z.enum(SALE_DISCOUNT_MODES).optional().default("porcentaje"),
    itemDiscountDraft: z.string().optional().default(""),
    suppressCatalogDiscount: z.boolean().optional(),
    comment: z.string().max(500).optional(),
    promotionSelections: z.array(salePromotionSelectionSchema).optional(),
    promotionDealDiscount: z.number().nonnegative().optional(),
    promotionDealId: uuid.optional(),
    promotionDealName: z.string().optional(),
    lineGroupId: z.string().max(120).optional(),
  })
  .refine(
    (line) =>
      [line.articleId, line.recipeId, line.promotionId].filter(Boolean).length ===
      1,
    { message: "Cada línea tiene que ser artículo, receta o promoción." },
  )
  .openapi("CreateSaleLine")

export const checkoutCheckDetailsSchema = z
  .object({
    checkNumber: z.string().trim().min(1),
    bankName: z.string().trim().min(1),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    partyName: z.string().optional().default(""),
    partyId: z.string().optional().default(""),
    notes: z.string().optional().default(""),
  })
  .openapi("SaleCheckoutCheckDetails")

export const createSaleChannelSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("pos") }).openapi("SaleChannelPos"),
    z
      .object({
        type: z.literal("table"),
        sessionId: uuid,
        closeOnComplete: z.boolean().optional(),
        partial: z.boolean().optional(),
      })
      .openapi("SaleChannelTable"),
    z
      .object({
        type: z.literal("counter"),
        orderId: uuid,
        linkOnComplete: z.boolean().optional(),
        partial: z.boolean().optional(),
      })
      .openapi("SaleChannelCounter"),
  ])
  .openapi("SaleChannel")

export const createSaleBodySchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(80),
    lines: z.array(createSaleLineSchema).min(1).max(200),
    clientId: uuid.nullable().optional(),
    paymentKind: z.enum(OPERATION_PAYMENT_KINDS).nullable().optional(),
    treasuryAccountId: uuid.nullable().optional(),
    checkDetails: checkoutCheckDetailsSchema.nullable().optional(),
    payOnClientAccount: z.boolean().optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    generalDiscountMode: z.enum(SALE_DISCOUNT_MODES),
    valorDescuentoPorcentaje: z.number().min(0).max(100).optional().default(0),
    valorDescuentoFijo: z.number().min(0).optional().default(0),
    invoiceTypeLabel: z.string().nullable().optional(),
    customerIvaCondition: z.enum(CLIENT_IVA_CONDITIONS).nullable().optional(),
    fiscalCustomer: z
      .object({
        name: z.string(),
        taxId: z.string().nullable(),
      })
      .nullable()
      .optional(),
    channel: createSaleChannelSchema.optional().default({ type: "pos" }),
  })
  .openapi("CreateSale")

export const createSaleDataSchema = z
  .object({
    saleId: uuid,
    replayed: z.boolean().optional(),
  })
  .openapi("CreateSaleData")

export const createSaleResponseSchema = okDataSchema(
  createSaleDataSchema,
  "CreateSaleResponse",
)

export type CreateSaleBody = z.infer<typeof createSaleBodySchema>
export type CreateSaleLine = z.infer<typeof createSaleLineSchema>
export type CreateSaleChannel = z.infer<typeof createSaleChannelSchema>
