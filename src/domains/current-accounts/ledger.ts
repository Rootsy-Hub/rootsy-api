import type { SupabaseClient } from "@supabase/supabase-js"
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
  const { data: maxRow } = await supabase
    .from("accounting_entries")
    .select("entry_number")
    .eq("pop_id", popId)
    .order("entry_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  return maxRow?.entry_number != null && Number.isFinite(Number(maxRow.entry_number))
    ? Number(maxRow.entry_number) + 1
    : 1
}

export async function cancelCurrentAccountAccountingEntry(
  supabase: SupabaseClient,
  entryId: string,
): Promise<void> {
  await supabase
    .from("accounting_entries")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", entryId)
}

export async function postCurrentAccountReceiptLedger(
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
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
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
  const { data: entIns, error: entErr } = await supabase
    .from("accounting_entries")
    .insert({
      pop_id: args.popId,
      entry_number: nextNum,
      entry_date: args.entryDate,
      source_type: "current_account_receipt",
      source_id: args.receiptId,
      description,
      status: "draft",
      created_by: args.userId,
    })
    .select("id")
    .single()

  if (entErr || !entIns?.id) {
    return { success: false, error: entErr?.message || "No se pudo crear el asiento." }
  }
  const entryId = String(entIns.id)

  const { error: linesErr } = await supabase
    .from("accounting_entry_lines")
    .insert(lines.map((line) => ({ ...line, entry_id: entryId })))
  if (linesErr) {
    await cancelCurrentAccountAccountingEntry(supabase, entryId)
    return { success: false, error: linesErr.message || "No se pudieron crear las líneas." }
  }

  const { error: postErr } = await supabase
    .from("accounting_entries")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: args.userId,
    })
    .eq("id", entryId)
  if (postErr) {
    await cancelCurrentAccountAccountingEntry(supabase, entryId)
    return { success: false, error: postErr.message || "No se pudo registrar el asiento." }
  }

  return { success: true, entryId }
}
