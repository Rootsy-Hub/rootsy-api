import { z } from "zod"

export const SUPPLIER_SEARCH_LIMIT = 8

export const listSuppliersQuerySchema = z.object({
  q: z.string().optional().default(""),
})

export type SupplierOption = {
  id: string
  name: string
}
