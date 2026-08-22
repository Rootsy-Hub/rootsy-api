import { z } from "zod"

export const SERVICE_KINDS = ["fijo", "variable"] as const

export const serviceKindSchema = z.enum(SERVICE_KINDS)

export const listServiceCategoriesQuerySchema = z.object({
  kind: serviceKindSchema.optional(),
  includeDeleted: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v == null ? undefined : v === "true")),
})

export const createServiceCategoryBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre no puede quedar vacío."),
  kind: serviceKindSchema.default("variable"),
  sortOrder: z.number().int().optional(),
})

export const updateServiceCategoryBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    kind: serviceKindSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Nada para actualizar",
  })

export type ServiceCategoryRow = {
  id: string
  popId: string
  name: string
  kind: (typeof SERVICE_KINDS)[number]
  sortOrder: number
  deletedAt: string | null
  createdAt: string
}
