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
