import { z } from "zod"

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
