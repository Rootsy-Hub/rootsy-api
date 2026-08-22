import { z } from "zod"
import type { TreasuryAccountKind } from "./kinds.js"

const isoDate = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim() ?? ""
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null
  })

export const periodQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
})

export type TreasuryPeriodReportRow = {
  id: string
  name: string
  kind: TreasuryAccountKind
  brandKey: string | null
  isActive: boolean
  chartAccountCode: string
  openingBalance: number | null
  closingBalance: number
  periodIn: number
  periodOut: number
  toLiquidateBalance: number | null
  toPayBalance: number | null
  hasPosIntegration: boolean
  hasCardIntegration: boolean
}

export type TreasuryPeriodPopInfo = {
  popName: string
  popStreetAddress: string | null
  popFiscalCuit: string | null
  popFiscalRazonSocial: string | null
}

export type TreasuryPeriodData = {
  rows: TreasuryPeriodReportRow[]
  popInfo: TreasuryPeriodPopInfo
}

export type TreasuryPeriodTotals = {
  accountCount: number
  closingBalance: number
  periodIn: number
  periodOut: number
}

export const createTreasuryAccountBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio."),
  kind: z.enum(["cash", "bank", "wallet"]),
  sortOrder: z.number().int(),
  brandKey: z.string().trim().nullable().optional(),
})

export const updateTreasuryAccountBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio."),
})

export const setTreasuryAccountActiveBodySchema = z.object({
  isActive: z.boolean(),
})

export const createTreasuryChildBodySchema = z.object({
  kind: z.enum(["pos", "card_payable"]),
  name: z.string().trim().min(1, "El nombre es obligatorio."),
})

export type CreateTreasuryAccountBody = z.infer<
  typeof createTreasuryAccountBodySchema
>
export type UpdateTreasuryAccountBody = z.infer<
  typeof updateTreasuryAccountBodySchema
>
export type SetTreasuryAccountActiveBody = z.infer<
  typeof setTreasuryAccountActiveBodySchema
>
export type CreateTreasuryChildBody = z.infer<typeof createTreasuryChildBodySchema>
export type TreasuryChildAccountKind = CreateTreasuryChildBody["kind"]

export type TreasuryAccountListRow = {
  id: string
  name: string
  kind: TreasuryAccountKind
  brandKey: string | null
  isSystemDefault: boolean
  isActive: boolean
  sortOrder: number
  accountingAccountId: string
  accountingAccountLabel: string
  chartAccountCode: string
  isCardPayable: boolean
  hasPosIntegration: boolean
  hasCardIntegration: boolean
}

export type TreasuryAccountBalance = {
  ledgerBalance: number | null
  toLiquidateBalance: number
  toPayBalance: number
  outstandingBalance: number
  settledTotal: number
}

export type TreasuryFundingOption = {
  id: string
  name: string
  kind: TreasuryAccountKind
}

export type TreasuryChildAccountRow = {
  id: string
  name: string
  kind: TreasuryAccountKind
  chartAccountCode: string
  childRole: "pos" | "card_payable"
  ledgerBalance: number | null
  outstandingBalance: number
  settledTotal: number
}

export type TreasuryMercadoPagoConnection = {
  id: string
  treasuryAccountId: string
  status: "disconnected" | "connected" | "expired"
  mpUserId: string | null
  mpEmail: string | null
  connectedAt: string | null
  disconnectedAt: string | null
}

export type TreasuryAccountPageData = {
  account: TreasuryAccountListRow
  children: TreasuryChildAccountRow[]
  isMother: boolean
  parentAccount: { id: string; name: string } | null
  fundingAccounts: TreasuryFundingOption[]
  mercadopagoConnection: TreasuryMercadoPagoConnection | null
}

export type TreasuryAccountTotals = {
  ledgerBalance: number | null
  toLiquidateBalance: number
  toPayBalance: number
  openingBalance: number | null
  currentBalance: number | null
  periodIn: number
  periodOut: number
  children: Array<{
    id: string
    ledgerBalance: number | null
    outstandingBalance: number
    settledTotal: number
  }>
}

export type PaymentKind =
  | "cash"
  | "card_debit"
  | "card_credit"
  | "transfer"
  | "check"
  | "other"

export type TreasuryMovementRow = {
  id: string
  movementRefId: string
  kind:
    | "sale"
    | "purchase"
    | "expense"
    | "employee_payment"
    | "card_settlement"
    | "funding_out"
    | "cash_register_close"
    | "pos_liquidation"
    | "pos_liquidation_fee"
  date: string
  occurredAt?: string
  amount: number
  label: string
  adjustmentAmount?: number
  direction: "in" | "out"
  balanceImpact: "real" | "informative"
  reconciled: boolean
  linkedStatementLineId: string | null
  sourceAccountName?: string | null
  treasuryAccountLabel?: string | null
  paymentKind?: PaymentKind | null
  saleChannel?: "pos" | "table" | "counter" | null
}

export type TreasurySettlementRow = {
  id: string
  amount: number
  settledAt: string
  notes: string
  fundingMethodName: string | null
}

export type BankStatementLineRow = {
  id: string
  lineDate: string
  description: string
  amount: number
  direction: "in" | "out"
  source: "manual" | "csv"
  reconciled: boolean
}

export type TreasuryAccountMovementsData = {
  settlements: TreasurySettlementRow[]
  movements: TreasuryMovementRow[]
  movementTotals: { in: number; out: number; net: number }
  statementLines: BankStatementLineRow[]
  supportsBankReconciliation: boolean
  reconciliationSummary: {
    movementsReconciled: number
    movementsPending: number
    statementReconciled: number
    statementPending: number
    statementTotalIn: number
    statementTotalOut: number
  }
}

const isoDateRequired = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida.")

export const statementImportBodySchema = z.object({
  csvText: z.string().min(1, "El CSV está vacío."),
})

export const statementLineBodySchema = z.object({
  lineDate: isoDateRequired,
  description: z.string().trim().optional(),
  amount: z.number().positive("El importe debe ser mayor a cero."),
  direction: z.enum(["in", "out"]),
})

export const reconciliationMarkBodySchema = z.object({
  movementKind: z.enum(["sale", "purchase", "expense", "funding_out"]),
  movementRefId: z.string().trim().min(1, "Referencia de movimiento inválida."),
  statementLineId: z.string().uuid().nullable().optional(),
})

export const clearReconciliationMarkBodySchema = z.object({
  movementKind: z.enum([
    "sale",
    "purchase",
    "expense",
    "funding_out",
    "card_settlement",
    "cash_register_close",
    "pos_liquidation",
    "pos_liquidation_fee",
  ]),
  movementRefId: z.string().trim().min(1, "Referencia de movimiento inválida."),
})

export const settlementBodySchema = z.object({
  cardTreasuryAccountId: z.string().uuid(),
  fundingTreasuryAccountId: z.string().uuid(),
  principalAmount: z.number().positive("El importe debe ser mayor a cero."),
  adjustmentAmount: z.number().min(0).optional(),
  settledAt: isoDateRequired,
  notes: z.string().optional(),
})

export const posAcreditationBodySchema = z.object({
  posTreasuryAccountId: z.string().uuid(),
  motherTreasuryAccountId: z.string().uuid().optional(),
  principalAmount: z.number().positive("El importe debe ser mayor a cero."),
  adjustmentAmount: z.number().min(0).optional(),
  creditedAt: isoDateRequired,
  notes: z.string().optional(),
})

export const childPendingQuerySchema = z.object({
  asOf: isoDateRequired,
  role: z.enum(["pos", "card_payable"]),
})

export const reconciliationHistoryQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  child: z.string().uuid().optional(),
  role: z.enum(["pos", "card_payable"]).optional(),
})

export type StatementImportBody = z.infer<typeof statementImportBodySchema>
export type StatementLineBody = z.infer<typeof statementLineBodySchema>
export type ReconciliationMarkBody = z.infer<typeof reconciliationMarkBodySchema>
export type ClearReconciliationMarkBody = z.infer<
  typeof clearReconciliationMarkBodySchema
>
export type SettlementBody = z.infer<typeof settlementBodySchema>
export type PosAcreditationBody = z.infer<typeof posAcreditationBodySchema>

export type TreasuryReconciliationEventRow = {
  id: string
  kind: "pos_acreditation" | "card_settlement" | "cash_register_close_adjustment"
  eventDate: string
  eventOccurredAt?: string
  accountName: string
  principalAmount: number
  adjustmentAmount: number
  totalAmount: number
  notes: string
  accountingEntryId: string | null
  accountingEntryNumber: number | null
  accountingEntryStatus: string | null
  createdByName?: string | null
}

export type TreasuryPosSummaryMovementRow = {
  id: string
  kind:
    | "pos_sale"
    | "cash_register_close"
    | "purchase_payment"
    | "expense_payment"
  date: string
  amount: number
  direction: "in" | "out"
  label: string
}

export type TreasuryReconciliationHistoryData = {
  events: TreasuryReconciliationEventRow[]
  periodGrossAmount: number
  periodPendingBalance: number
  openingPendingBalance: number | null
  periodToLiquidate: number
  summaryMovements: TreasuryPosSummaryMovementRow[]
}
