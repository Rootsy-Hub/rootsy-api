import { z } from "zod"

export const ACCOUNT_TYPES = [
  "activo_corriente",
  "activo_no_corriente",
  "pasivo_corriente",
  "pasivo_no_corriente",
  "patrimonio_neto",
  "ingresos",
  "costos",
  "gastos",
] as const

export type AccountType = (typeof ACCOUNT_TYPES)[number]

export type AccountNature = "deudora" | "acreedora"

export const OPERATIONAL_TOTAL_KINDS = [
  "sales",
  "purchases",
  "expenses",
  "issued-invoices",
  "received-invoices",
] as const

export type OperationalTotalKind = (typeof OPERATIONAL_TOTAL_KINDS)[number]

const emptyToNull = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim() ?? ""
    return t.length > 0 ? t : null
  })

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

export const asOfQuerySchema = z.object({
  asOf: isoDate,
})

export const totalsQuerySchema = z.object({
  kind: z.enum(OPERATIONAL_TOTAL_KINDS),
  from: isoDate,
  to: isoDate,
})

export const journalQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(40),
})

export const journalTotalsQuerySchema = periodQuerySchema

export const ledgerQuerySchema = z.object({
  accountCode: z.string().trim().min(1),
  from: isoDate,
  to: isoDate,
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(40),
})

export const chartSearchQuerySchema = z.object({
  q: z.string().optional().default(""),
})

export const chartReportQuerySchema = asOfQuerySchema

export type PeriodQuery = z.infer<typeof periodQuerySchema>

export type ChartAccountRow = {
  id: string
  parentId: string | null
  code: string
  name: string
  accountType: AccountType
  nature: AccountNature
  level: number
  isMovementAccount: boolean
}

export type ChartAccountSearchRow = {
  id: string
  code: string
  name: string
}

export type JournalEntrySummaryRow = {
  id: string
  entryNumber: number
  entryDate: string
  description: string
  sourceType: string
  totalDebit: number
  totalCredit: number
}

export type JournalEntryLineRow = {
  id: string
  accountCode: string
  accountName: string
  debitAmount: number
  creditAmount: number
  lineDescription: string | null
}

export type LedgerMovementRow = {
  id: string
  entryDate: string
  entryNumber: number
  entryDescription: string
  debitAmount: number
  creditAmount: number
  runningBalance: number
}

export type TrialBalanceRow = {
  accountCode: string
  accountName: string
  accountType: AccountType
  sumDebit: number
  sumCredit: number
  balance: number
}

export type FinancialSummaryRow = {
  label: string
  total: number
  accountTypes: AccountType[]
}

export type BalanceSheetSectionRow = {
  accountCode: string
  accountName: string
  balance: number
}

export type BalanceSheetSection = {
  key: "activo" | "pasivo" | "patrimonio"
  title: string
  rows: BalanceSheetSectionRow[]
  sectionTotal: number
}

export type BalanceSheetResult = {
  asOf: string
  sections: BalanceSheetSection[]
  resultadoAcumulado: number
  totalActivo: number
  totalPasivo: number
  totalPatrimonioCuentas: number
  totalPasivoPatrimonioYResultado: number
  diferenciaCuadre: number
}

export type IncomeStatementLine = {
  accountCode: string
  accountName: string
  accountType: AccountType
  balance: number
}

export type IncomeStatementResult = {
  from: string
  to: string
  ingresos: IncomeStatementLine[]
  costos: IncomeStatementLine[]
  gastos: IncomeStatementLine[]
  totalIngresos: number
  totalCostos: number
  totalGastos: number
  resultadoNeto: number
}

export type CashFlowRow = {
  accountCode: string
  accountName: string
  entityName: string | null
  entradas: number
  salidas: number
  neto: number
}

export type VatPositionRow = {
  accountCode: string
  accountName: string
  accountType: AccountType
  sumDebit: number
  sumCredit: number
  balance: number
}

export type ChartOfAccountsReportRow = ChartAccountRow & {
  balance: number
}

export type ChartOfAccountsReportData = {
  asOf: string
  rows: ChartOfAccountsReportRow[]
}

export type OperationalTotalsData = {
  kind: OperationalTotalKind
  count: number
  total: number
  iva: number | null
}

export type JournalListData = {
  entries: JournalEntrySummaryRow[]
  hasMore: boolean
  page: number
  pageSize: number
  totalCount: number
}

export type JournalTotalsData = {
  totalCount: number
  periodTotalDebit: number
  periodTotalCredit: number
}

export type LedgerListData = {
  accountName: string
  nature: AccountNature
  rows: LedgerMovementRow[]
  hasMore: boolean
  page: number
  pageSize: number
  totalCount: number
}

export type LedgerTotalsData = {
  accountName: string
  nature: AccountNature
  totalCount: number
  totalDebit: number
  totalCredit: number
  closingBalance: number
}

