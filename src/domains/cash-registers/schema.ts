import { z } from "zod"
import type { CashRegisterClosingComparisonLine } from "./settlement.js"

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

export type ClosingSnapshot = {
  cash: number
  payment_methods?: Record<string, number>
  treasury_lines?: Record<string, number>
  note?: string | null
}

export type CashRegisterPeriodRow = {
  id: string
  status: "closed"
  openedAt: string
  closedAt: string | null
  openingCash: number
  openingNote: string | null
  closingSnapshot: ClosingSnapshot | null
  movementDeposits: number
  movementWithdrawals: number
  totalCobrado: number
  ventasPorMedio: { paymentKind: string; name: string; total: number }[]
  ventasPorCuenta: []
  ventasParaCierre: []
  arqueoNumber: number
  openedByUserId: string | null
  openedByName: string | null
  closedByUserId: string | null
  closedByName: string | null
  efectivoTeorico: number
  cashArqueoDifference: number | null
  registerId: string
  registerName: string
}

export type CashRegistersPeriodPopInfo = {
  popName: string
  popStreetAddress: string | null
  popFiscalCuit: string | null
  popFiscalRazonSocial: string | null
}

export type CashRegistersPeriodData = {
  rows: CashRegisterPeriodRow[]
  registerCount: number
  popInfo: CashRegistersPeriodPopInfo
}

export type CashRegistersPeriodTotals = {
  registerCount: number
  closedCount: number
  totalCobrado: number
  netDifference: number
  sessionsWithVariance: number
}

const optionalUuid = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    const t = (v ?? "").trim()
    if (!t || t === "none") return null
    return t
  })
  .refine((v) => v == null || z.string().uuid().safeParse(v).success, {
    message: "Punto de venta AFIP inválido.",
  })

export const createCashRegisterBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio."),
  sortOrder: z.number().int().optional().default(0),
  cashTreasuryAccountId: z
    .string()
    .uuid("Elegí una cuenta de efectivo destino."),
  arcaSalePointId: optionalUuid,
})

export const updateCashRegisterBodySchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio."),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean(),
  cashTreasuryAccountId: z
    .string()
    .uuid("Elegí una cuenta de efectivo destino."),
  arcaSalePointId: optionalUuid,
})

export const openSessionBodySchema = z.object({
  openingCash: z.number().min(0, "El efectivo de apertura no puede ser negativo."),
  note: z.string().optional().nullable(),
})

export const closeSessionBodySchema = z.object({
  cash: z.number().min(0, "El efectivo contado no puede ser negativo."),
  payment_methods: z.record(z.string(), z.number()).optional(),
  treasury_lines: z.record(z.string(), z.number()).optional(),
  note: z.string().optional().nullable(),
})

export const addMovementBodySchema = z.object({
  kind: z.enum(["deposit", "withdrawal"]),
  amount: z.number().positive("El monto debe ser mayor a cero."),
  note: z.string().optional().nullable(),
})

export type CreateCashRegisterBody = z.infer<typeof createCashRegisterBodySchema>
export type UpdateCashRegisterBody = z.infer<typeof updateCashRegisterBodySchema>
export type PatchCashRegisterBody = Partial<UpdateCashRegisterBody>
export type OpenSessionBody = z.infer<typeof openSessionBodySchema>
export type CloseSessionBody = z.infer<typeof closeSessionBodySchema>
export type AddMovementBody = z.infer<typeof addMovementBodySchema>

export type CashRegisterCloseCobroLine = {
  key: string
  treasuryAccountId: string | null
  paymentKind: string
  accountName: string | null
  label: string
  total: number
}

export type CashRegisterTreasuryLineCobro = {
  key: string
  treasuryAccountId: string | null
  paymentKind: string
  accountName: string | null
  label: string
  total: number
}

export type CashRegisterOpenSessionTotals = {
  openingCash: number
  ventasEfectivo: number
  ingresosCajon: number
  egresosCajon: number
  efectivoTeoricoEnCajon: number
  totalCobradoTurno: number | null
  cobrosPorMedio: { name: string; kind: string; total: number }[] | null
  cobrosPorCuenta: CashRegisterTreasuryLineCobro[] | null
  cobrosParaCierre: CashRegisterCloseCobroLine[] | null
}

export type CashRegisterOpenSessionMeta = {
  arqueoNumber: number
  openedByUserId: string | null
  openedByName: string | null
  openingNote: string | null
}

export type CashRegisterListRow = {
  id: string
  name: string
  sortOrder: number
  isActive: boolean
  cashTreasuryAccountId: string | null
  arcaSalePointId: string | null
  arcaPtoVta: number | null
  openSessionId: string | null
  canCloseOpenSession: boolean
  cashBalance: null
  openedAt: string | null
  openSessionMeta: CashRegisterOpenSessionMeta | null
  openSessionTotals: null
}

export type CashRegisterOpenTotals = {
  cashBalance: number
  openSessionTotals: CashRegisterOpenSessionTotals
}

export type CashTreasuryAccountOption = {
  id: string
  name: string
}

export type ArcaSalePointOption = {
  id: string
  ptoVta: number
  configured: boolean
}

export type PaymentMethodOption = {
  kind: string
  label: string
}

export type CashRegistersFormContext = {
  cashTreasuryAccounts: CashTreasuryAccountOption[]
  salePoints: ArcaSalePointOption[]
  paymentMethods: PaymentMethodOption[]
}

export type CashRegisterSummaryMovement = {
  id: string
  sessionId: string
  sessionOpenedAt: string
  createdAt: string
  kind: "deposit" | "withdrawal"
  amount: number
  note: string | null
  createdBy: string | null
}

export type CashRegisterSummarySession = {
  id: string
  status: "open" | "closed"
  openedAt: string
  closedAt: string | null
  openingCash: number
  openingNote: string | null
  closingSnapshot: ClosingSnapshot | null
  movementDeposits: number
  movementWithdrawals: number
  totalCobrado: number
  ventasPorMedio: { paymentKind: string; name: string; total: number }[]
  ventasPorCuenta: CashRegisterTreasuryLineCobro[]
  ventasParaCierre: CashRegisterCloseCobroLine[]
  arqueoNumber: number
  openedByUserId: string | null
  openedByName: string | null
  closedByUserId: string | null
  closedByName: string | null
  efectivoTeorico: number
  cashArqueoDifference: number | null
}

export type CashRegisterSummaryClosingBlock = {
  sessionId: string
  openedAt: string
  closedAt: string | null
  lines: { label: string; amount: number }[]
}

export type CashRegisterArqueoVentaPorMedio = {
  paymentKind: string
  name: string
  kind: string
  totalVentas: number
}

export type CashRegisterArqueoSesionAbierta = {
  sessionId: string
  openingCash: number
  ventasEfectivo: number
  ingresosCajon: number
  egresosCajon: number
  efectivoTeoricoEnCajon: number
}

export type CashRegisterPageData = {
  registerId: string
  registerName: string
  isActive: boolean
  operationalDayCloseTime: string
  sessions: CashRegisterSummarySession[]
  movements: CashRegisterSummaryMovement[]
}

export type CashRegisterSessionMoney = {
  totalCobrado: number
  ventasPorMedio: { paymentKind: string; name: string; total: number }[]
  ventasPorCuenta: CashRegisterTreasuryLineCobro[]
  ventasParaCierre: CashRegisterCloseCobroLine[]
  efectivoTeorico: number
  cashArqueoDifference: number | null
}

export type CashRegisterOperationSaleLine = {
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
  discountAmount: number
  discountLabel: string | null
  comment: string | null
  extras: string | null
}

export type CashRegisterSessionOperationRow = {
  id: string
  kind: "sale" | "deposit" | "withdrawal"
  saleId: string | null
  occurredAt: string
  operationLabel: string
  customerLabel: string
  detail: string
  paymentMethodLabel: string
  amount: number
  lines: CashRegisterOperationSaleLine[]
  showLines: boolean
  generalDiscountAmount: number
}

export type CashRegisterSessionArqueoDetail = {
  registerName: string
  popName: string
  session: CashRegisterSummarySession
  closingComparison: CashRegisterClosingComparisonLine[]
  hasAccountingEntry: boolean
  operations: CashRegisterSessionOperationRow[]
}

export type CashRegisterTotalsData = {
  sessionsById: Record<string, CashRegisterSessionMoney>
  arqueo: {
    ventasPorMedioPago: CashRegisterArqueoVentaPorMedio[]
    sesionAbierta: CashRegisterArqueoSesionAbierta | null
  } | null
  totals: {
    depositTotal: number
    withdrawalTotal: number
    netCashMovements: number
  }
  closingBlocks: CashRegisterSummaryClosingBlock[]
  aggregatedClosingLines: { label: string; amount: number }[]
}
