import { z } from "@hono/zod-openapi"
import { okDataSchema } from "../../openapi/schemas.js"

export const ITEM_KINDS = ["merchandise", "raw_material", "supply"] as const

export const itemKindSchema = z.enum(ITEM_KINDS)

const boolFilter = z.enum(["true", "false"]).optional().openapi({
  description: "true/false. Ausente = no filtra.",
})

export const listCategoriesQuerySchema = z
  .object({
    itemKind: itemKindSchema.optional(),
    showInSale: boolFilter,
    showInMenu: boolFilter,
    visible: boolFilter,
  })
  .openapi("ListCategoriesQuery")

export function toListCategoriesQuery(
  parsed: z.infer<typeof listCategoriesQuerySchema>,
): {
  itemKind?: (typeof ITEM_KINDS)[number]
  showInSale?: boolean
  showInMenu?: boolean
  visible?: boolean
} {
  return {
    itemKind: parsed.itemKind,
    showInSale:
      parsed.showInSale == null ? undefined : parsed.showInSale === "true",
    showInMenu:
      parsed.showInMenu == null ? undefined : parsed.showInMenu === "true",
    visible: parsed.visible == null ? undefined : parsed.visible === "true",
  }
}

export const createCategoryBodySchema = z
  .object({
    name: z.string().trim().min(1, "El nombre no puede quedar vacío."),
    itemKind: itemKindSchema.default("merchandise"),
    visible: z.boolean().optional(),
    showInSale: z.boolean().optional(),
    showInMenu: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("CreateCategory")

export const updateCategoryBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    itemKind: itemKindSchema.optional(),
    visible: z.boolean().optional(),
    showInSale: z.boolean().optional(),
    showInMenu: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Nada para actualizar",
  })
  .openapi("UpdateCategory")

export const layoutCategoriesBodySchema = z
  .object({
    updates: z
      .array(
        z.object({
          id: z.string().uuid(),
          sortOrder: z.number().int().min(0),
          showInSale: z.boolean(),
        }),
      )
      .min(1, "Nada para actualizar"),
  })
  .openapi("LayoutCategories")

export const categoryRowSchema = z
  .object({
    id: z.string(),
    popId: z.string(),
    name: z.string(),
    itemKind: itemKindSchema,
    visible: z.boolean(),
    showInSale: z.boolean(),
    showInMenu: z.boolean(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Category")

export const categoryDetailSchema = categoryRowSchema
  .extend({
    articleCount: z.number().int(),
  })
  .openapi("CategoryDetail")

export const categoryListResponseSchema = okDataSchema(
  z.array(categoryRowSchema),
  "CategoryListResponse",
)

export const categoryResponseSchema = okDataSchema(
  categoryRowSchema,
  "CategoryResponse",
)

export const categoryDetailResponseSchema = okDataSchema(
  categoryDetailSchema,
  "CategoryDetailResponse",
)

export type CategoryRow = z.infer<typeof categoryRowSchema>
export type CategoryDetail = z.infer<typeof categoryDetailSchema>
