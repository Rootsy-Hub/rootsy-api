import type { SupabaseClient } from "@supabase/supabase-js"
import { roundMoney } from "../reports/money.js"
import { resolveTreasuryAccountLedgerAccountId } from "./chart.js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
  type LedgerLineOp,
} from "../../audit/ledgerOps.js"
import type { AuditOp } from "../../audit/types.js"

const CHART_GASTOS_GENERALES = ["6.2.1.99", "6.2.1.02", "6.2.1.01"] as const
const CHART_GASTOS_FINANCIEROS = ["6.3.1.01", ...CHART_GASTOS_GENERALES] as const
const CHART_GASTOS_COMERCIALES = [
  "6.2.1.02",
  "6.3.1.01",
  ...CHART_GASTOS_GENERALES,
] as const
const CHART_TARJETAS_CREDITO_A_PAGAR = ["2.1.1.03", "2.1.1.02"] as const

async function resolveAccountId(
  supabase: SupabaseClient,
  popId: string,
  codes: readonly string[],
): Promise<string | null> {
  for (const code of codes) {
    const { data: row } = await supabase
      .from("accounting_chart_of_accounts")
      .select("id")
      .eq("pop_id", popId)
      .eq("code", code)
      .maybeSingle()
    if (row?.id) return String(row.id)
  }
  return null
}

async function nextEntryNumber(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  return nextAccountingEntryNumber(supabase, popId)
}

type LedgerLine = LedgerLineOp

export async function buildBalancedEntryOps(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    entryDate: string
    sourceType: string
    sourceId: string
    description: string
    lines: LedgerLine[]
  },
): Promise<{ success: true; entryId: string; ops: AuditOp[] } | { success: false; error: string }> {
  const { popId, userId, entryDate, sourceType, sourceId, description, lines } =
    args

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return { success: false, error: "Fecha de asiento inválida." }
  }

  let debitTotal = 0
  let creditTotal = 0
  for (const line of lines) {
    debitTotal = roundMoney(debitTotal + line.debit_amount)
    creditTotal = roundMoney(creditTotal + line.credit_amount)
  }
  if (Math.abs(debitTotal - creditTotal) > 0.009) {
    return { success: false, error: "El asiento no balancea." }
  }

  const nextNum = await nextEntryNumber(supabase, popId)
  const ledger = postedAccountingEntryOps({
    popId,
    userId,
    entryNumber: nextNum,
    entryDate,
    sourceType,
    sourceId,
    description,
    lines,
  })
  return { success: true, entryId: ledger.entryId, ops: ledger.ops }
}

export async function buildTreasurySettlementLedgerOps(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    settlementId: string
    principal: number
    adjustment: number
    settledAt: string
    cardTreasuryAccountId: string
    fundingTreasuryAccountId: string
  },
): Promise<{ success: true; entryId: string; ops: AuditOp[] } | { success: false; error: string }> {
  const { popId, userId, settlementId } = args
  const principal = roundMoney(args.principal)
  const adjustment = roundMoney(args.adjustment)
  const bankOut = roundMoney(principal + adjustment)
  if (!(principal > 0)) {
    return { success: false, error: "Importe de liquidación inválido." }
  }

  const entryDate = String(args.settledAt ?? "").slice(0, 10)
  const cardTaId = args.cardTreasuryAccountId
  const fundTaId = args.fundingTreasuryAccountId

  let cardLabel = "Tarjeta"
  const { data: cardTa } = await supabase
    .from("treasury_accounts")
    .select("name")
    .eq("id", cardTaId)
    .eq("pop_id", popId)
    .maybeSingle()
  cardLabel = String(cardTa?.name ?? "Tarjeta").trim()
  const entryDescription = `Pago resumen tarjeta — ${cardLabel}`

  let liabilityAccountId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    cardTaId,
  )
  if (!liabilityAccountId) {
    liabilityAccountId = await resolveAccountId(
      supabase,
      popId,
      CHART_TARJETAS_CREDITO_A_PAGAR,
    )
  }
  if (!liabilityAccountId) {
    return {
      success: false,
      error: "No hay cuenta Tarjetas de crédito a pagar en el plan de cuentas.",
    }
  }

  const bankAccountId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    fundTaId,
  )
  if (!bankAccountId) {
    return {
      success: false,
      error:
        "Configurá una cuenta contable en la cuenta de tesorería usada para pagar el resumen.",
    }
  }

  const lines: LedgerLine[] = [
    {
      account_id: liabilityAccountId,
      debit_amount: principal,
      credit_amount: 0,
      description: entryDescription,
      line_order: 1,
    },
  ]

  if (adjustment > 0) {
    const expenseAccountId = await resolveAccountId(
      supabase,
      popId,
      CHART_GASTOS_FINANCIEROS,
    )
    if (!expenseAccountId) {
      return {
        success: false,
        error:
          "No hay cuenta de gastos financieros para registrar cargos del resumen.",
      }
    }
    lines.push({
      account_id: expenseAccountId,
      debit_amount: adjustment,
      credit_amount: 0,
      description: `${entryDescription} — intereses y otros cargos del resumen`,
      line_order: 2,
    })
  }

  lines.push({
    account_id: bankAccountId,
    debit_amount: 0,
    credit_amount: bankOut,
    description: entryDescription,
    line_order: lines.length + 1,
  })

  return buildBalancedEntryOps(supabase, {
    popId,
    userId,
    entryDate,
    sourceType: "treasury_settlement",
    sourceId: settlementId,
    description: entryDescription,
    lines,
  })
}

export async function buildPosAcreditationLedgerOps(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    acreditationId: string
    principal: number
    adjustment: number
    creditedAt: string
    notes: string
    posTreasuryAccountId: string
    motherTreasuryAccountId: string
  },
): Promise<{ success: true; entryId: string; ops: AuditOp[] } | { success: false; error: string }> {
  const { popId, userId, acreditationId } = args
  const principal = roundMoney(args.principal)
  const adjustment = roundMoney(args.adjustment)
  const posCredit = roundMoney(principal + adjustment)
  if (!(principal > 0)) {
    return { success: false, error: "Importe de acreditación inválido." }
  }

  const entryDate = String(args.creditedAt ?? "").slice(0, 10)
  const posTaId = args.posTreasuryAccountId
  const motherTaId = args.motherTreasuryAccountId

  const { data: posTa } = await supabase
    .from("treasury_accounts")
    .select("name")
    .eq("id", posTaId)
    .eq("pop_id", popId)
    .maybeSingle()
  const posName = String(posTa?.name ?? "POS").trim()
  const notes = args.notes.trim()
  const entryDescription = notes
    ? `Acreditación POS — ${posName} (${notes})`
    : `Acreditación POS — ${posName}`

  const posLedgerId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    posTaId,
  )
  const bankLedgerId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    motherTaId,
  )
  if (!posLedgerId || !bankLedgerId) {
    return {
      success: false,
      error: "No se encontraron las cuentas contables vinculadas.",
    }
  }

  const lines: LedgerLine[] = [
    {
      account_id: bankLedgerId,
      debit_amount: principal,
      credit_amount: 0,
      description: entryDescription,
      line_order: 1,
    },
  ]

  if (adjustment > 0) {
    const expenseAccountId = await resolveAccountId(
      supabase,
      popId,
      CHART_GASTOS_COMERCIALES,
    )
    if (!expenseAccountId) {
      return {
        success: false,
        error: "No hay cuenta de gastos para registrar comisiones e impuestos.",
      }
    }
    lines.push({
      account_id: expenseAccountId,
      debit_amount: adjustment,
      credit_amount: 0,
      description: `${entryDescription} — comisiones e impuestos`,
      line_order: 2,
    })
  }

  lines.push({
    account_id: posLedgerId,
    debit_amount: 0,
    credit_amount: posCredit,
    description: entryDescription,
    line_order: lines.length + 1,
  })

  return buildBalancedEntryOps(supabase, {
    popId,
    userId,
    entryDate,
    sourceType: "treasury_pos_acreditation",
    sourceId: acreditationId,
    description: entryDescription,
    lines,
  })
}
