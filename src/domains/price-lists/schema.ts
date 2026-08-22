import { z } from "zod"

export const createPriceListBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre no puede quedar vacío."),
})

export const updatePriceListBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre no puede quedar vacío."),
})

export type PriceListRow = {
  id: string
  name: string
  isDefault: boolean
  sortOrder: number
}
