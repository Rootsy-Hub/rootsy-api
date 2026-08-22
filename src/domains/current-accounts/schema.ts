import { z } from "zod"

export const CURRENT_ACCOUNT_TABLE_PAGE_SIZES = [10, 25, 50] as const
export const DEFAULT_CURRENT_ACCOUNT_TABLE_PAGE_SIZE = 25
export const CURRENT_ACCOUNT_TABLE_SORT_KEYS = [
  "party_name",
  "credit_limit",
  "term_days",
  "open_count",
  "overdue",
  "balance",
] as const
export const CURRENT_ACCOUNT_DIRECTIONS = ["receivable", "payable"] as const
export const CURRENT_ACCOUNT_AGING_FILTERS = [
  "all",
  "current",
  "d1_30",
  "d31_60",
  "d61_plus",
] as const
export const OPERATION_PAYMENT_KINDS = [
  "cash",
  "card_debit",
  "card_credit",
  "transfer",
  "check",
  "other",
] as const

export type CurrentAccountDirection = (typeof CURRENT_ACCOUNT_DIRECTIONS)[number]
export type CurrentAccountAgingFilter =
  (typeof CURRENT_ACCOUNT_AGING_FILTERS)[number]
export type CurrentAccountAgingBucket = Exclude<CurrentAccountAgingFilter, "all">
export type CurrentAccountTableSortKey =
  (typeof CURRENT_ACCOUNT_TABLE_SORT_KEYS)[number]
export type CurrentAccountDocumentKind = "sale" | "purchase"
export type OperationPaymentKind = (typeof OPERATION_PAYMENT_KINDS)[number]

export const listCurrentAccountsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .default(DEFAULT_CURRENT_ACCOUNT_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  direction: z.enum(CURRENT_ACCOUNT_DIRECTIONS).optional(),
  aging: z.enum(CURRENT_ACCOUNT_AGING_FILTERS).optional(),
  sort: z.enum(CURRENT_ACCOUNT_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type ListCurrentAccountsQuery = {
  page: number
  pageSize: number
  search: string
  direction: CurrentAccountDirection
  aging: CurrentAccountAgingFilter
  sort: CurrentAccountTableSortKey | null
  ord: "asc" | "desc"
}

export function toListCurrentAccountsQuery(
  parsed: z.infer<typeof listCurrentAccountsQuerySchema>,
): ListCurrentAccountsQuery {
  const pageSize = CURRENT_ACCOUNT_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof CURRENT_ACCOUNT_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_CURRENT_ACCOUNT_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    direction: parsed.direction ?? "receivable",
    aging: parsed.aging ?? "all",
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export const searchCandidatesQuerySchema = z.object({
  q: z.string().optional().default(""),
  direction: z.enum(CURRENT_ACCOUNT_DIRECTIONS),
})

export const enrollmentBodySchema = z.object({
  direction: z.enum(CURRENT_ACCOUNT_DIRECTIONS),
  partyId: z.string().uuid(),
  enabled: z.boolean(),
  creditLimit: z.number().nullable().optional(),
  termDays: z.number().optional(),
})

export type EnrollmentBody = z.infer<typeof enrollmentBodySchema>

const applicationSchema = z.object({
  documentId: z.string().uuid(),
  amount: z.number(),
})

export const settleBodySchema = z.object({
  direction: z.enum(CURRENT_ACCOUNT_DIRECTIONS),
  partyId: z.string().uuid(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentKind: z.enum(OPERATION_PAYMENT_KINDS),
  treasuryAccountId: z.string().optional().default(""),
  checkDetails: z.unknown().optional(),
  applications: z.array(applicationSchema).optional().default([]),
  extraAmount: z.number().optional(),
  notes: z.string().optional(),
})

export type SettleBody = z.infer<typeof settleBodySchema>

export const applyCreditBodySchema = z.object({
  direction: z.enum(CURRENT_ACCOUNT_DIRECTIONS),
  partyId: z.string().uuid(),
  applications: z.array(applicationSchema),
})

export type ApplyCreditBody = z.infer<typeof applyCreditBodySchema>

export type CurrentAccountAgingTotals = Record<CurrentAccountAgingBucket, number>

export type CurrentAccountPartyRow = {
  partyId: string
  partyName: string
  enrolled: boolean
  openCount: number
  overdueAmount: number
  aging: CurrentAccountAgingTotals
  balance: number
  unappliedCredit: number
  creditLimit: number | null
  termDays: number
}

export type CurrentAccountLedgerLine = {
  id: string
  date: string
  occurredAt: string | null
  documentLabel: string
  description: string
  paymentKindLabel: string | null
  debit: number
  credit: number
  balance: number
}

export type CurrentAccountOpenDocument = {
  id: string
  date: string
  occurredAt: string | null
  dueDate: string
  documentLabel: string
  remaining: number
  daysOverdue: number
  agingBucket: CurrentAccountAgingBucket
}

export type CurrentAccountListData = {
  parties: CurrentAccountPartyRow[]
  totalCount: number
  page: number
  pageSize: number
  direction: CurrentAccountDirection
}

export type CurrentAccountLedgerData = {
  partyName: string
  balance: number
  openCount: number
  overdueAmount: number
  aging: CurrentAccountAgingTotals
  lines: CurrentAccountLedgerLine[]
  openDocuments: CurrentAccountOpenDocument[]
  unappliedCredit: number
  enrolled: boolean
  creditLimit: number | null
  termDays: number
  availableCredit: number | null
}

export type CurrentAccountEnrollmentCandidate = {
  id: string
  name: string
  taxId: string | null
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
