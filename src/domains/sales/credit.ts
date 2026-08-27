import type { SupabaseClient } from "@supabase/supabase-js"
import {
  CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS,
  currentAccountOpenAmount,
  normalizeCurrentAccountCreditLimit,
  normalizeCurrentAccountTermDays,
  roundMoney,
} from "../current-accounts/accounts.js"

export async function assertClientCurrentAccountCredit(
  supabase: SupabaseClient,
  popId: string,
  clientId: string,
  addAmount: number,
): Promise<
  | { ok: true; termDays: number }
  | { ok: false; error: string; status: 400 }
> {
  const { data } = await supabase
    .from("clients")
    .select(
      "id, current_account_enabled, current_account_credit_limit, current_account_term_days",
    )
    .eq("id", clientId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (!data || data.current_account_enabled !== true) {
    return {
      ok: false,
      error:
        "Este cliente no está dado de alta en Cuentas corrientes. Dalo de alta para vender a cuenta.",
      status: 400,
    }
  }
  const creditLimit = normalizeCurrentAccountCreditLimit(
    data.current_account_credit_limit,
  )
  const termDays = normalizeCurrentAccountTermDays(data.current_account_term_days)
  const { data: saleRows } = await supabase
    .from("sales")
    .select("id, total")
    .eq("pop_id", popId)
    .eq("client_id", clientId)
    .eq("on_account", true)
    .eq("status", "completed")
  const saleIds = (saleRows ?? []).map((row) => String(row.id))
  const allocated = await loadAllocated("sale", supabase, popId, saleIds)
  let remaining = 0
  for (const row of saleRows ?? []) {
    const open = currentAccountOpenAmount(
      Number(row.total ?? 0) || 0,
      allocated.get(String(row.id)) ?? 0,
    )
    if (open > 0.009) remaining = roundMoney(remaining + open)
  }
  const { data: receipts } = await supabase
    .from("current_account_receipts")
    .select("id, amount")
    .eq("pop_id", popId)
    .eq("direction", "receivable")
    .eq("client_id", clientId)
  const receiptRows = receipts ?? []
  let unapplied = 0
  if (receiptRows.length > 0) {
    const receiptIds = receiptRows.map((row) => String(row.id))
    const { data: appRows } = await supabase
      .from("current_account_applications")
      .select("receipt_id, amount")
      .eq("pop_id", popId)
      .in("receipt_id", receiptIds)
    const applied = new Map<string, number>()
    for (const row of appRows ?? []) {
      const id = String(row.receipt_id ?? "")
      applied.set(id, roundMoney((applied.get(id) ?? 0) + Number(row.amount ?? 0)))
    }
    for (const row of receiptRows) {
      const leftover = currentAccountOpenAmount(
        Number(row.amount ?? 0) || 0,
        applied.get(String(row.id)) ?? 0,
      )
      if (leftover > 0.009) unapplied = roundMoney(unapplied + leftover)
    }
  }
  const balance = roundMoney(remaining - unapplied)
  if (creditLimit != null && balance + addAmount > creditLimit + 0.009) {
    const money = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 2,
    })
    return {
      ok: false,
      error: `Este cliente tiene un límite de ${money.format(creditLimit)}. Con este comprobante el saldo quedaría en ${money.format(roundMoney(balance + addAmount))}.`,
      status: 400,
    }
  }
  return {
    ok: true,
    termDays: termDays || CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS,
  }
}

async function loadAllocated(
  kind: "sale",
  supabase: SupabaseClient,
  popId: string,
  documentIds: string[],
): Promise<Map<string, number>> {
  const allocated = new Map<string, number>()
  if (documentIds.length === 0) return allocated
  const { data } = await supabase
    .from("sale_payments")
    .select("sale_id, amount")
    .eq("pop_id", popId)
    .in("sale_id", documentIds)
  for (const row of data ?? []) {
    const id = String(row.sale_id ?? "")
    allocated.set(id, roundMoney((allocated.get(id) ?? 0) + Number(row.amount ?? 0)))
  }
  return allocated
}
