import { z } from "zod"

export const CHECK_TABLE_PAGE_SIZES = [10, 25, 50] as const
export const DEFAULT_CHECK_TABLE_PAGE_SIZE = 25

export const CHECK_TABLE_SORT_KEYS = [
  "check_number",
  "direction",
  "bank_name",
  "amount",
  "issue_date",
  "due_date",
  "status",
] as const

export const CHECK_DIRECTIONS = ["received", "issued"] as const
export const CHECK_STATUSES = [
  "in_portfolio",
  "deposited",
  "cleared",
  "rejected",
  "voided",
] as const
export const CHECK_SOURCE_KINDS = [
  "sale",
  "purchase",
  "expense",
  "service_charge",
  "manual",
] as const
export const CHECK_LIFECYCLE_ACTIONS = [
  "deposit",
  "clear",
  "reject",
  "void",
] as const

export type CheckDirection = (typeof CHECK_DIRECTIONS)[number]
export type CheckStatus = (typeof CHECK_STATUSES)[number]
export type CheckSourceKind = (typeof CHECK_SOURCE_KINDS)[number]
export type CheckLifecycleAction = (typeof CHECK_LIFECYCLE_ACTIONS)[number]
export type CheckTableSortKey = (typeof CHECK_TABLE_SORT_KEYS)[number]

export const listChecksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().default(DEFAULT_CHECK_TABLE_PAGE_SIZE),
  q: z.string().optional().default(""),
  direction: z.enum(CHECK_DIRECTIONS).optional(),
  status: z.enum(CHECK_STATUSES).optional(),
  sort: z.enum(CHECK_TABLE_SORT_KEYS).optional(),
  ord: z.enum(["asc", "desc"]).optional(),
})

export type ListChecksQuery = {
  page: number
  pageSize: number
  search: string
  direction: CheckDirection | ""
  status: CheckStatus | ""
  sort: CheckTableSortKey | null
  ord: "asc" | "desc"
}

export function toListChecksQuery(
  parsed: z.infer<typeof listChecksQuerySchema>,
): ListChecksQuery {
  const pageSize = CHECK_TABLE_PAGE_SIZES.includes(
    parsed.pageSize as (typeof CHECK_TABLE_PAGE_SIZES)[number],
  )
    ? parsed.pageSize
    : DEFAULT_CHECK_TABLE_PAGE_SIZE

  return {
    page: parsed.page,
    pageSize,
    search: parsed.q.trim(),
    direction: parsed.direction ?? "",
    status: parsed.status ?? "",
    sort: parsed.sort ?? null,
    ord: parsed.ord ?? "asc",
  }
}

export const searchCheckPartiesQuerySchema = z.object({
  q: z.string().optional().default(""),
  direction: z.enum(CHECK_DIRECTIONS),
})

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida")

export const createCheckBodySchema = z.object({
  direction: z.enum(CHECK_DIRECTIONS),
  checkNumber: z.string(),
  bankName: z.string(),
  amount: z.string(),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
  partyName: z.string().optional().default(""),
  partyId: z.string().optional().default(""),
  notes: z.string().optional().default(""),
})

export type CreateCheckBody = z.infer<typeof createCheckBodySchema>

export const depositCheckBodySchema = z.object({
  treasuryAccountId: z.string(),
  depositedAt: isoDateSchema,
})

export type DepositCheckBody = z.infer<typeof depositCheckBodySchema>

export const clearCheckBodySchema = z.object({
  clearedAt: isoDateSchema,
})

export type ClearCheckBody = z.infer<typeof clearCheckBodySchema>

export const rejectCheckBodySchema = z.object({
  rejectedAt: isoDateSchema,
  reason: z.string().optional().default(""),
})

export type RejectCheckBody = z.infer<typeof rejectCheckBodySchema>

export type CheckTableRow = {
  id: string
  direction: CheckDirection
  checkNumber: string
  bankName: string
  amount: number
  issueDate: string
  dueDate: string
  status: CheckStatus
  partyName: string
  sourceKind: CheckSourceKind
}

export type CheckListData = {
  checks: CheckTableRow[]
  totalCount: number
  page: number
  pageSize: number
}

export type CheckPartyItem = {
  id: string
  name: string
  taxId: string | null
}

export type CheckDepositAccount = {
  id: string
  name: string
}
