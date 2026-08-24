import type { SupabaseClient } from "@supabase/supabase-js"
import { isValidOperationPaymentKind, roundMoney } from "./accounts.js"
import type { OperationPaymentKind } from "./schema.js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
  type LedgerLineOp,
} from "../../audit/ledgerOps.js"
import type { AuditOp } from "../../audit/types.js"

const PAYMENT_KIND_ACCOUNT_FALLBACK: Record<
  OperationPaymentKind,
  readonly string[]
> = {
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

export async function buildExpensePaymentLedgerOps(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    expensePaymentId: string
    expenseId: string
    amount: number
    paidAt: string
    paymentKind: string | null
    treasuryAccountId: string | null
  },
): Promise<
  | { success: true; entryId: string; ops: AuditOp[] }
  | { success: false; error: string }
> {
  const { popId, userId, expensePaymentId } = args

  const { data: expRow, error: expErr } = await supabase
    .from("expenses")
    .select(
      `
      id,
      description,
      status,
      expense_categories ( name, kind, accounting_chart_account_id )
    `,
    )
    .eq("id", args.expenseId)
    .eq("pop_id", popId)
    .maybeSingle()

  if (expErr || !expRow) {
    return { success: false, error: expErr?.message || "Gasto no encontrado." }
  }

  const catRaw = expRow.expense_categories as unknown as
    | {
        name?: string
        kind?: string
        accounting_chart_account_id?: string | null
      }
    | {
        name?: string
        kind?: string
        accounting_chart_account_id?: string | null
      }[]
    | null
  const cat = Array.isArray(catRaw) ? catRaw[0] : catRaw
  if (String(expRow.status ?? "") === "voided") {
    return { success: false, error: "El gasto está anulado." }
  }
  if (String(cat?.kind ?? "") === "otro") {
    return {
      success: false,
      error: "Esa cuenta la registra otro módulo. Acá solo se mira.",
    }
  }

  const amt = roundMoney(Number(args.amount ?? 0))
  if (!(amt > 0)) {
    return { success: false, error: "Importe de pago inválido." }
  }

  const categoryName = String(cat?.name ?? "")
  const expenseDesc = String(expRow.description ?? "").trim()
  const paidAt = String(args.paidAt ?? "").slice(0, 10)
  const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(paidAt)
    ? paidAt
    : new Date().toISOString().slice(0, 10)

  const paymentKind = args.paymentKind != null ? String(args.paymentKind) : "other"
  const treasuryAccountId = args.treasuryAccountId
  const paymentAccountId = await resolveLedgerAccountForTreasuryPayment(
    supabase,
    popId,
    paymentKind,
    treasuryAccountId,
  )
  if (!paymentAccountId) {
    return {
      success: false,
      error:
        "Configurá una cuenta contable en el medio de pago o el plan de cuentas (caja/bancos) para registrar el pago.",
    }
  }

  const expenseAccountId =
    cat?.accounting_chart_account_id != null
      ? String(cat.accounting_chart_account_id)
      : null
  if (!expenseAccountId) {
    return {
      success: false,
      error: "Esta categoría no tiene cuenta en el plan de cuentas.",
    }
  }

  const entryDescription = `Gasto — ${categoryName || "Sin categoría"}${expenseDesc ? ` — ${expenseDesc}` : ""}`
  const nextNum = await nextEntryNumber(supabase, popId)
  const lines: LedgerLineOp[] = [
    {
      account_id: expenseAccountId,
      debit_amount: amt,
      credit_amount: 0,
      description: entryDescription,
      line_order: 1,
    },
    {
      account_id: paymentAccountId,
      debit_amount: 0,
      credit_amount: amt,
      description: entryDescription,
      line_order: 2,
    },
  ]
  const ledger = postedAccountingEntryOps({
    popId,
    userId,
    entryNumber: nextNum,
    entryDate,
    sourceType: "expense_payment",
    sourceId: expensePaymentId,
    description: entryDescription,
    lines,
  })
  return { success: true, entryId: ledger.entryId, ops: ledger.ops }
}

export async function buildExpenseVoidReversalOps(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    expenseId: string
    entryDate: string
  },
): Promise<{ success: true; ops: AuditOp[] } | { success: false; error: string }> {
  const { popId, userId, expenseId, entryDate } = args
  const ops: AuditOp[] = []

  const { data: payRows, error: payErr } = await supabase
    .from("expense_payments")
    .select("id, accounting_entry_id, reversal_accounting_entry_id")
    .eq("pop_id", popId)
    .eq("expense_id", expenseId)

  if (payErr) {
    return { success: false, error: payErr.message || "No se pudieron leer los pagos del gasto." }
  }

  let nextNum = await nextEntryNumber(supabase, popId)
  for (const p of payRows || []) {
    const pid = String(p.id)
    const origId = p.accounting_entry_id != null ? String(p.accounting_entry_id) : ""
    const revId =
      p.reversal_accounting_entry_id != null
        ? String(p.reversal_accounting_entry_id)
        : ""
    if (!origId || revId) continue

    const { data: origEntry, error: oe } = await supabase
      .from("accounting_entries")
      .select("id, status, description")
      .eq("id", origId)
      .eq("pop_id", popId)
      .maybeSingle()
    if (oe || !origEntry?.id) {
      return { success: false, error: oe?.message || "Asiento original no encontrado." }
    }
    if (String(origEntry.status ?? "") !== "posted") {
      return {
        success: false,
        error: "El asiento original no está registrado; no se puede revertir.",
      }
    }

    const { data: lineRows, error: le } = await supabase
      .from("accounting_entry_lines")
      .select("account_id, debit_amount, credit_amount, description, line_order")
      .eq("entry_id", origId)
      .order("line_order", { ascending: true })
    if (le) {
      return { success: false, error: le.message || "No se pudieron leer las líneas del asiento." }
    }
    const lines = lineRows || []
    if (lines.length < 1) {
      return { success: false, error: "El asiento original no tiene líneas." }
    }

    const baseDesc = String(origEntry.description ?? "Anulación gasto")
    const revDescription = `Anulación — ${baseDesc}`
    const ledger = postedAccountingEntryOps({
      popId,
      userId,
      entryNumber: nextNum,
      entryDate,
      sourceType: "expense_void",
      sourceId: pid,
      description: revDescription,
      lines: lines.map((row, i) => {
        const d = roundMoney(Number(row.debit_amount ?? 0))
        const c = roundMoney(Number(row.credit_amount ?? 0))
        return {
          account_id: String(row.account_id),
          debit_amount: c,
          credit_amount: d,
          description: revDescription,
          line_order: i + 1,
        }
      }),
    })
    nextNum += 1
    ops.push(...ledger.ops)
    ops.push({
      op: "update",
      table: "expense_payments",
      id: pid,
      row: { reversal_accounting_entry_id: ledger.entryId },
    })
  }

  return { success: true, ops }
}
