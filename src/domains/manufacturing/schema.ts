import { z } from "zod"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const listManufacturingQuerySchema = z.object({
  from: z.string().optional().default(""),
  to: z.string().optional().default(""),
})

export const createManufacturingRunBodySchema = z.object({
  recipeId: z.string().uuid(),
  quantity: z.number(),
  producedAt: z.string(),
  expiresAt: z.string().nullable().optional(),
  notes: z.string().optional().default(""),
})

export type CreateManufacturingRunBody = z.infer<
  typeof createManufacturingRunBodySchema
>

export function parseIsoDate(raw: unknown): string | null {
  if (raw == null) return null
  const iso = String(raw).trim().slice(0, 10)
  if (!ISO_DATE.test(iso)) return null
  const [year, month, day] = iso.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return iso
}

export type ManufacturingIngredientPreview = {
  articleId: string
  articleName: string
  unitOfMeasure: string
  quantityPerUnit: number
  wastePct: number | null
  consumeQty: number
  onHand: number
}

export type ManufacturableRecipe = {
  id: string
  name: string
  outputArticleId: string
  outputArticleName: string
  outputUnitOfMeasure: string
  allowNegativeStock: boolean
  ingredients: ManufacturingIngredientPreview[]
}

export type ManufacturingRunRow = {
  id: string
  producedAt: string
  recipeId: string
  recipeName: string
  outputArticleId: string
  outputArticleName: string
  outputUnitOfMeasure: string
  quantity: number
  unitCost: number
  totalCost: number
  expiresAt: string | null
  producedByName: string
}

export type ManufacturingListData = {
  runs: ManufacturingRunRow[]
  recipes: ManufacturableRecipe[]
  canCreate: boolean
}
