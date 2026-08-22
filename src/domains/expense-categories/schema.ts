import { z } from "zod"
import { EXPENSE_FAMILIES } from "./chart.js"

export const EXPENSE_KINDS = ["fijo", "variable", "otro"] as const
export const EXPENSE_WRITE_KINDS = ["fijo", "variable"] as const

export const expenseKindSchema = z.enum(EXPENSE_KINDS)
export const expenseWriteKindSchema = z.enum(EXPENSE_WRITE_KINDS)
export const expenseFamilySchema = z.enum(EXPENSE_FAMILIES)

export const listExpenseCategoriesQuerySchema = z.object({
  kind: expenseKindSchema.optional(),
  includeDeleted: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v == null ? undefined : v === "true")),
})

export const createExpenseCategoryBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre no puede quedar vacío."),
  kind: expenseWriteKindSchema,
  family: expenseFamilySchema,
})

export const updateExpenseCategoryBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    kind: expenseWriteKindSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Nada para actualizar",
  })

export type ExpenseCategoryRow = {
  id: string
  popId: string
  name: string
  kind: (typeof EXPENSE_KINDS)[number]
  sortOrder: number
  deletedAt: string | null
  accountingChartAccountId: string | null
  accountCode: string | null
  createdAt: string
  readOnly: boolean
  canDelete: boolean
}
