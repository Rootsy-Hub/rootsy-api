import { z } from "zod"

export const ITEM_KINDS = ["merchandise", "raw_material", "supply"] as const

export const itemKindSchema = z.enum(ITEM_KINDS)

export const listCategoriesQuerySchema = z.object({
  itemKind: itemKindSchema.optional(),
  showInSale: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v == null ? undefined : v === "true")),
  showInMenu: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v == null ? undefined : v === "true")),
  visible: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v == null ? undefined : v === "true")),
})

export const createCategoryBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre no puede quedar vacío."),
  itemKind: itemKindSchema.default("merchandise"),
  visible: z.boolean().optional(),
  showInSale: z.boolean().optional(),
  showInMenu: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

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

export const layoutCategoriesBodySchema = z.object({
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

export type CategoryRow = {
  id: string
  popId: string
  name: string
  itemKind: (typeof ITEM_KINDS)[number]
  visible: boolean
  showInSale: boolean
  showInMenu: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}
