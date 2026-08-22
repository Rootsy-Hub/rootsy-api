import { z } from "zod"
import type { ExpenseCategoryRow } from "../expense-categories/schema.js"

export const EXPENSE_STATUSES = [
  "pending",
  "partial",
  "paid",
  "voided",
] as const

export const OPERATION_PAYMENT_KINDS = [
  "cash",
  "card_debit",
  "card_credit",
  "transfer",
  "check",
  "other",
] as const

export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number]
export type ExpenseCategoryKind = "fijo" | "variable" | "otro"
export type OperationPaymentKind = (typeof OPERATION_PAYMENT_KINDS)[number]

export const listExpensesQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
})

export type ListExpensesQuery = {
  year: number
  month: number
}

export const createExpenseBodySchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number(),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  description: z.string().optional().default(""),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
})

export type CreateExpenseBody = z.infer<typeof createExpenseBodySchema>

export const recordExpensePaymentBodySchema = z.object({
  amount: z.number(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentKind: z.enum(OPERATION_PAYMENT_KINDS).nullable().optional(),
  treasuryAccountId: z.string().optional().nullable(),
  checkDetails: z.unknown().optional(),
})

export type RecordExpensePaymentBody = z.infer<
  typeof recordExpensePaymentBodySchema
>

export const voidExpenseBodySchema = z.object({
  reason: z.string().optional().default(""),
})

export type VoidExpenseBody = z.infer<typeof voidExpenseBodySchema>

export type ExpenseListRow = {
  id: string
  amount: number
  currency: string
  expenseDate: string
  dueDate: string | null
  description: string
  status: ExpenseStatus
  voidedAt: string | null
  voidReason: string | null
  categoryId: string
  categoryName: string
  categoryKind: ExpenseCategoryKind
  categoryDeletedAt: string | null
  paidTotal: number
}

export type MonthProgress = {
  totalDue: number
  totalPaid: number
}

export type ExpenseListData = {
  rows: ExpenseListRow[]
  ledgerByCategoryId: Record<string, number>
  progress: MonthProgress
  categories: ExpenseCategoryRow[]
}

export type TreasuryPaymentPickOption = {
  id: string
  name: string
}

export type TreasuryPaymentContext = {
  defaultCashTreasuryAccountId: string | null
  cashTreasuryAccounts: TreasuryPaymentPickOption[]
  bankTreasuryAccounts: TreasuryPaymentPickOption[]
  posTreasuryAccounts: TreasuryPaymentPickOption[]
  payTreasuryAccounts: TreasuryPaymentPickOption[]
  checkReceivableTreasuryAccountId: string | null
  checkPayableTreasuryAccountId: string | null
}
