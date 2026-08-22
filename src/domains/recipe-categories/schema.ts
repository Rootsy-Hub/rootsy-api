import { z } from "zod"

export const listRecipeCategoriesQuerySchema = z.object({
  showInMenu: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v == null ? undefined : v === "true")),
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v == null ? undefined : v === "true")),
})

export const createRecipeCategoryBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre no puede quedar vacío."),
  stationId: z.string().uuid().nullable().optional(),
  showInMenu: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

export const updateRecipeCategoryBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    stationId: z.string().uuid().nullable().optional(),
    showInMenu: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Nada para actualizar",
  })

export const layoutRecipeCategoriesBodySchema = z.object({
  updates: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0),
        showInMenu: z.boolean(),
      }),
    )
    .min(1, "Nada para actualizar"),
})

export type RecipeCategoryRow = {
  id: string
  popId: string
  name: string
  sortOrder: number
  showInMenu: boolean
  isActive: boolean
  stationId: string | null
  stationName: string | null
  createdAt: string
  updatedAt: string
}

export type RecipeCategoryDetail = RecipeCategoryRow & {
  recipeCount: number
}
