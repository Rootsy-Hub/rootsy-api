import type { SupabaseClient } from "@supabase/supabase-js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
  type LedgerLineOp,
} from "../../audit/ledgerOps.js"
import type { AuditOp } from "../../audit/types.js"
import { isValidOperationPaymentKind, roundMoney } from "./accounts.js"
import type { CurrentAccountDirection, OperationPaymentKind } from "./schema.js"

const CHART_CUENTAS_POR_COBRAR_CODES = ["1.1.2.01"] as const
const CHART_PROVEEDORES_CC_CODES = ["2.1.1.01"] as const

const PAYMENT_KIND_ACCOUNT_FALLBACK: Record<OperationPaymentKind, readonly string[]> = {
  cash: ["1.1.1.01"],
  transfer: ["1.1.1.02", "1.1.1.04"],
  card_debit: ["1.1.1.03"],
  card_credit: ["1.1.1.03"],
  check: ["1.1.2.02", "2.1.1.02"],
  other: ["1.1.1.02", "1.1.1.04"],
}

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

async function resolveTreasuryAccountLedgerAccountId(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("treasury_accounts")
    .select("accounting_chart_account_id")
    .eq("pop_id", popId)
    .eq("id", treasuryAccountId)
    .maybeSingle()
  return data?.accounting_chart_account_id
    ? String(data.accounting_chart_account_id)
    : null
}

async function resolveLedgerAccountForTreasuryPayment(
  supabase: SupabaseClient,
  popId: string,
  paymentKind: string,
  treasuryAccountId: string | null | undefined,
): Promise<string | null> {
  const kind = isValidOperationPaymentKind(paymentKind) ? paymentKind : "other"
  const taId = treasuryAccountId?.trim() || null
  if (taId) {
    const fromTreasury = await resolveTreasuryAccountLedgerAccountId(
      supabase,
      popId,
      taId,
    )
    if (fromTreasury) return fromTreasury
  }
  return resolveAccountId(supabase, popId, PAYMENT_KIND_ACCOUNT_FALLBACK[kind])
}

async function nextEntryNumber(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  return nextAccountingEntryNumber(supabase, popId)
}

export async function buildCurrentAccountReceiptLedgerOps(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    receiptId: string
    direction: CurrentAccountDirection
    amount: number
    entryDate: string
    partyName: string
    paymentKind: string
    treasuryAccountId: string
  },
): Promise<{ success: true; entryId: string; ops: AuditOp[] } | { success: false; error: string }> {
  const amount = roundMoney(args.amount)
  if (!(amount > 0)) {
    return { success: false, error: "Importe de recibo inválido." }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.entryDate)) {
    return { success: false, error: "Fecha de asiento inválida." }
  }

  const partyAccountId = await resolveAccountId(
    supabase,
    args.popId,
    args.direction === "payable"
      ? CHART_PROVEEDORES_CC_CODES
      : CHART_CUENTAS_POR_COBRAR_CODES,
  )
  if (!partyAccountId) {
    return {
      success: false,
      error:
        args.direction === "payable"
          ? "Falta Proveedores (2.1.1.01) en el plan de cuentas."
          : "Falta Cuentas por cobrar (1.1.2.01) en el plan de cuentas.",
    }
  }

  const treasuryAccountId = await resolveLedgerAccountForTreasuryPayment(
    supabase,
    args.popId,
    args.paymentKind,
    args.treasuryAccountId,
  )
  if (!treasuryAccountId) {
    return {
      success: false,
      error: "Configurá una cuenta contable en el medio de cobro o pago.",
    }
  }

  const description =
    args.direction === "payable"
      ? `Pago a ${args.partyName}`
      : `Cobro de ${args.partyName}`

  const lines =
    args.direction === "payable"
      ? [
          {
            account_id: partyAccountId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: treasuryAccountId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]
      : [
          {
            account_id: treasuryAccountId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: partyAccountId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]

  const nextNum = await nextEntryNumber(supabase, args.popId)
  const ledger = postedAccountingEntryOps({
    popId: args.popId,
    userId: args.userId,
    entryNumber: nextNum,
    entryDate: args.entryDate,
    sourceType: "current_account_receipt",
    sourceId: args.receiptId,
    description,
    lines: lines as LedgerLineOp[],
  })
  return { success: true, entryId: ledger.entryId, ops: ledger.ops }
}
