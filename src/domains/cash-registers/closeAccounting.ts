import type { SupabaseClient } from "@supabase/supabase-js"
import { operationPaymentKindLabel } from "../operations/paymentLabels.js"
import { resolveTreasuryAccountLedgerAccountId } from "../treasury/chart.js"
import { roundMoney } from "../reports/money.js"
import {
  formatTreasuryCloseLineLabel,
  parseCloseTreasuryLineKey,
} from "./settlement.js"
import {
  resolveAccountIdByCodes,
  resolveLedgerAccountForTreasuryPayment,
} from "./paymentLedger.js"
import type {
  SessionCloseCobro,
  SessionPaymentKindCobro,
  SessionTreasuryLineCobro,
} from "./cobros.js"

const CHART_DIFERENCIA_ARQUEO_GASTO_CODES = [
  "6.1.1.05",
  "6.2.1.02",
  "6.2.1.03",
] as const

const CHART_ARQUEO_SOBRANTE_INGRESO_CODES = ["4.2.1.01", "4.1.1.01"] as const

export type CloseAccountingLine = {
  account_id: string
  debit_amount: number
  credit_amount: number
  description: string | null
  line_order: number
}

export async function buildTreasuryLineCloseAdjustmentLines(
  supabase: SupabaseClient,
  popId: string,
  declaredByLine: Record<string, number>,
  cobrosByLine: Array<SessionCloseCobro | SessionTreasuryLineCobro>,
  lineOrderStart: number,
): Promise<
  | { success: true; lines: CloseAccountingLine[]; nextLineOrder: number }
  | { success: false; error: string }
> {
  const lines: CloseAccountingLine[] = []
  let lineOrder = lineOrderStart
  const cobroMap = new Map(cobrosByLine.map((row) => [row.key, row]))
  const processed = new Set<string>()

  const appendDiff = async (
    lineKey: string,
    declaredRaw: number,
    cobrado: number,
    cobro: SessionCloseCobro | SessionTreasuryLineCobro | null,
  ): Promise<{ success: true } | { success: false; error: string }> => {
    const diff = roundMoney(declaredRaw - cobrado)
    if (Math.abs(diff) < 0.01) return { success: true }

    const parsed = parseCloseTreasuryLineKey(lineKey)
    const paymentKind = cobro?.paymentKind ?? parsed.paymentKind ?? "other"
    const treasuryAccountId =
      cobro?.treasuryAccountId ?? parsed.treasuryAccountId

    const assetAccountId = treasuryAccountId
      ? ((await resolveTreasuryAccountLedgerAccountId(
          supabase,
          popId,
          treasuryAccountId,
        )) ??
        (await resolveLedgerAccountForTreasuryPayment(
          supabase,
          popId,
          paymentKind,
          treasuryAccountId,
        )))
      : await resolveLedgerAccountForTreasuryPayment(
          supabase,
          popId,
          paymentKind,
          null,
        )
    if (!assetAccountId) {
      const label =
        cobro && "label" in cobro && cobro.label
          ? cobro.label
          : formatTreasuryCloseLineLabel(cobro?.accountName ?? null, paymentKind)
      return {
        success: false,
        error: `No hay cuenta contable para ajustar ${label} al cierre de caja.`,
      }
    }

    const absDiff = Math.abs(diff)
    const label =
      cobro && "label" in cobro && cobro.label
        ? cobro.label
        : formatTreasuryCloseLineLabel(cobro?.accountName ?? null, paymentKind)
    const desc =
      diff < 0
        ? `Faltante liquidación ${label} (${absDiff.toFixed(2)})`
        : `Sobrante liquidación ${label} (${absDiff.toFixed(2)})`

    if (diff < 0) {
      const gastoId = await resolveAccountIdByCodes(
        supabase,
        popId,
        CHART_DIFERENCIA_ARQUEO_GASTO_CODES,
      )
      if (!gastoId) {
        return {
          success: false,
          error:
            "No hay cuenta de gasto para diferencias de liquidación (p. ej. 6.1.1.05) en el plan de cuentas.",
        }
      }
      lines.push(
        {
          account_id: gastoId,
          debit_amount: absDiff,
          credit_amount: 0,
          description: desc,
          line_order: lineOrder,
        },
        {
          account_id: assetAccountId,
          debit_amount: 0,
          credit_amount: absDiff,
          description: desc,
          line_order: lineOrder + 1,
        },
      )
    } else {
      const ingresoId = await resolveAccountIdByCodes(
        supabase,
        popId,
        CHART_ARQUEO_SOBRANTE_INGRESO_CODES,
      )
      if (!ingresoId) {
        return {
          success: false,
          error:
            "No hay cuenta de otros ingresos para sobrantes de liquidación (p. ej. 4.2.1.01) en el plan de cuentas.",
        }
      }
      lines.push(
        {
          account_id: assetAccountId,
          debit_amount: absDiff,
          credit_amount: 0,
          description: desc,
          line_order: lineOrder,
        },
        {
          account_id: ingresoId,
          debit_amount: 0,
          credit_amount: absDiff,
          description: desc,
          line_order: lineOrder + 1,
        },
      )
    }

    lineOrder += 2
    return { success: true }
  }

  for (const [lineKey, declaredRaw] of Object.entries(declaredByLine)) {
    processed.add(lineKey)
    const cobro = cobroMap.get(lineKey) ?? null
    const cobrado = cobro?.total ?? 0
    const res = await appendDiff(lineKey, declaredRaw, cobrado, cobro)
    if (!res.success) return res
  }

  for (const cobro of cobrosByLine) {
    if (processed.has(cobro.key)) continue
    const res = await appendDiff(cobro.key, 0, cobro.total, cobro)
    if (!res.success) return res
  }

  return { success: true, lines, nextLineOrder: lineOrder }
}

export async function buildCashCloseAdjustmentLines(
  supabase: SupabaseClient,
  popId: string,
  cashDifference: number,
  lineOrderStart: number,
): Promise<
  | { success: true; lines: CloseAccountingLine[]; nextLineOrder: number }
  | { success: false; error: string }
> {
  const absDiff = Math.abs(cashDifference)
  if (absDiff < 0.01) {
    return { success: true, lines: [], nextLineOrder: lineOrderStart }
  }

  const cajaId = await resolveAccountIdByCodes(supabase, popId, ["1.1.1.01"])
  if (!cajaId) {
    return {
      success: false,
      error:
        "No hay cuenta Caja (p. ej. 1.1.1.01) en el plan de cuentas para el arqueo.",
    }
  }

  const descBase =
    cashDifference < 0
      ? `Faltante de arqueo de caja (${absDiff.toFixed(2)})`
      : `Sobrante de arqueo de caja (${absDiff.toFixed(2)})`

  if (cashDifference < 0) {
    const gastoId = await resolveAccountIdByCodes(
      supabase,
      popId,
      CHART_DIFERENCIA_ARQUEO_GASTO_CODES,
    )
    if (!gastoId) {
      return {
        success: false,
        error:
          "No hay cuenta de gasto para diferencias de arqueo (p. ej. 6.1.1.05) en el plan de cuentas.",
      }
    }
    return {
      success: true,
      lines: [
        {
          account_id: gastoId,
          debit_amount: absDiff,
          credit_amount: 0,
          description: descBase,
          line_order: lineOrderStart,
        },
        {
          account_id: cajaId,
          debit_amount: 0,
          credit_amount: absDiff,
          description: descBase,
          line_order: lineOrderStart + 1,
        },
      ],
      nextLineOrder: lineOrderStart + 2,
    }
  }

  const ingresoId = await resolveAccountIdByCodes(
    supabase,
    popId,
    CHART_ARQUEO_SOBRANTE_INGRESO_CODES,
  )
  if (!ingresoId) {
    return {
      success: false,
      error:
        "No hay cuenta de otros ingresos (p. ej. 4.2.1.01) en el plan de cuentas.",
    }
  }
  return {
    success: true,
    lines: [
      {
        account_id: cajaId,
        debit_amount: absDiff,
        credit_amount: 0,
        description: descBase,
        line_order: lineOrderStart,
      },
      {
        account_id: ingresoId,
        debit_amount: 0,
        credit_amount: absDiff,
        description: descBase,
        line_order: lineOrderStart + 1,
      },
    ],
    nextLineOrder: lineOrderStart + 2,
  }
}

export async function buildPaymentKindCloseAdjustmentLines(
  supabase: SupabaseClient,
  popId: string,
  declaredByKind: Record<string, number>,
  cobrosByKind: Map<string, SessionPaymentKindCobro>,
  lineOrderStart: number,
): Promise<
  | { success: true; lines: CloseAccountingLine[]; nextLineOrder: number }
  | { success: false; error: string }
> {
  const lines: CloseAccountingLine[] = []
  let lineOrder = lineOrderStart
  const processed = new Set<string>()

  const appendDiff = async (
    paymentKind: string,
    declaredRaw: number,
    cobrado: number,
    primaryTreasuryAccountId: string | null,
  ): Promise<{ success: true } | { success: false; error: string }> => {
    const diff = roundMoney(declaredRaw - cobrado)
    if (Math.abs(diff) < 0.01) return { success: true }

    const assetAccountId = primaryTreasuryAccountId
      ? ((await resolveTreasuryAccountLedgerAccountId(
          supabase,
          popId,
          primaryTreasuryAccountId,
        )) ??
        (await resolveLedgerAccountForTreasuryPayment(
          supabase,
          popId,
          paymentKind,
          primaryTreasuryAccountId,
        )))
      : await resolveLedgerAccountForTreasuryPayment(
          supabase,
          popId,
          paymentKind,
          null,
        )
    if (!assetAccountId) {
      return {
        success: false,
        error: `No hay cuenta contable para ajustar ${operationPaymentKindLabel(paymentKind)} al cierre de caja.`,
      }
    }

    const absDiff = Math.abs(diff)
    const label = operationPaymentKindLabel(paymentKind)
    const desc =
      diff < 0
        ? `Faltante liquidación ${label} (${absDiff.toFixed(2)})`
        : `Sobrante liquidación ${label} (${absDiff.toFixed(2)})`

    if (diff < 0) {
      const gastoId = await resolveAccountIdByCodes(
        supabase,
        popId,
        CHART_DIFERENCIA_ARQUEO_GASTO_CODES,
      )
      if (!gastoId) {
        return {
          success: false,
          error:
            "No hay cuenta de gasto para diferencias de liquidación (p. ej. 6.1.1.05) en el plan de cuentas.",
        }
      }
      lines.push(
        {
          account_id: gastoId,
          debit_amount: absDiff,
          credit_amount: 0,
          description: desc,
          line_order: lineOrder,
        },
        {
          account_id: assetAccountId,
          debit_amount: 0,
          credit_amount: absDiff,
          description: desc,
          line_order: lineOrder + 1,
        },
      )
    } else {
      const ingresoId = await resolveAccountIdByCodes(
        supabase,
        popId,
        CHART_ARQUEO_SOBRANTE_INGRESO_CODES,
      )
      if (!ingresoId) {
        return {
          success: false,
          error:
            "No hay cuenta de otros ingresos para sobrantes de liquidación (p. ej. 4.2.1.01) en el plan de cuentas.",
        }
      }
      lines.push(
        {
          account_id: assetAccountId,
          debit_amount: absDiff,
          credit_amount: 0,
          description: desc,
          line_order: lineOrder,
        },
        {
          account_id: ingresoId,
          debit_amount: 0,
          credit_amount: absDiff,
          description: desc,
          line_order: lineOrder + 1,
        },
      )
    }

    lineOrder += 2
    return { success: true }
  }

  for (const [paymentKind, declaredRaw] of Object.entries(declaredByKind)) {
    if (paymentKind === "cash") continue
    processed.add(paymentKind)
    const cobro = cobrosByKind.get(paymentKind)
    const res = await appendDiff(
      paymentKind,
      declaredRaw,
      cobro?.total ?? 0,
      cobro?.primaryTreasuryAccountId ?? null,
    )
    if (!res.success) return res
  }

  for (const [paymentKind, cobro] of cobrosByKind) {
    if (processed.has(paymentKind)) continue
    const res = await appendDiff(
      paymentKind,
      0,
      cobro.total,
      cobro.primaryTreasuryAccountId,
    )
    if (!res.success) return res
  }

  return { success: true, lines, nextLineOrder: lineOrder }
}
