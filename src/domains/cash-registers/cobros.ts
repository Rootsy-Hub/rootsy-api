import type { SupabaseClient } from "@supabase/supabase-js"
import { operationPaymentKindLabel } from "../operations/paymentLabels.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import {
  formatTreasuryCloseLineLabel,
  treasuryCloseAccountKey,
  treasuryCloseLineKey,
} from "./settlement.js"
import type {
  CashRegisterCloseCobroLine,
  CashRegisterTreasuryLineCobro,
} from "./schema.js"

export type SessionCloseCobro = CashRegisterCloseCobroLine
export type SessionTreasuryLineCobro = CashRegisterTreasuryLineCobro

export type SessionPaymentKindCobro = {
  total: number
  primaryTreasuryAccountId: string | null
}

type SalePaymentRow = {
  sale_id?: unknown
  payment_kind?: unknown
  amount?: unknown
  treasury_account_id?: unknown
  reversed_at?: unknown
  treasury_accounts?:
    | { name?: string; parent_treasury_account_id?: string | null }
    | Array<{ name?: string; parent_treasury_account_id?: string | null }>
    | null
}

function treasuryName(
  raw: SalePaymentRow["treasury_accounts"],
): string | null {
  const ta = Array.isArray(raw) ? raw[0] : raw
  return ta?.name?.trim() ?? null
}

export async function loadCompletedSalesForSessions(
  supabase: SupabaseClient,
  popId: string,
  sessionIds: string[],
): Promise<{ id: string; sessionId: string; total: number }[]> {
  if (sessionIds.length === 0) return []
  const { data } = await supabase
    .from("sales")
    .select("id, cash_register_session_id, total")
    .eq("pop_id", popId)
    .in("cash_register_session_id", sessionIds)
    .eq("status", "completed")
  return (data || []).map((row) => ({
    id: String(row.id),
    sessionId: String(row.cash_register_session_id ?? ""),
    total: parseMoney(row.total),
  }))
}

export async function loadSalePaymentsForSaleIds(
  supabase: SupabaseClient,
  popId: string,
  saleIds: string[],
  excludeReversed: boolean,
): Promise<SalePaymentRow[]> {
  if (saleIds.length === 0) return []
  let q = supabase
    .from("sale_payments")
    .select(
      "sale_id, payment_kind, amount, treasury_account_id, reversed_at, treasury_accounts ( name, parent_treasury_account_id )",
    )
    .eq("pop_id", popId)
    .in("sale_id", saleIds)
  if (excludeReversed) q = q.is("reversed_at", null)
  const { data } = await q
  return (data || []) as SalePaymentRow[]
}

export function cobrosForCloseFromPayments(
  payRows: SalePaymentRow[],
): SessionCloseCobro[] {
  const byAccount = new Map<
    string,
    {
      treasuryAccountId: string
      accountName: string | null
      total: number
      kinds: Set<string>
    }
  >()
  const unassigned = new Map<string, { paymentKind: string; total: number }>()

  for (const row of payRows) {
    const kind = String(row.payment_kind ?? "other")
    if (kind === "cash") continue
    const amount = parseMoney(row.amount)
    if (amount <= 0) continue
    const treasuryAccountId =
      row.treasury_account_id != null ? String(row.treasury_account_id) : null
    if (!treasuryAccountId) {
      const key = treasuryCloseLineKey(null, kind)
      const existing = unassigned.get(key)
      if (existing) existing.total += amount
      else unassigned.set(key, { paymentKind: kind, total: amount })
      continue
    }
    let bucket = byAccount.get(treasuryAccountId)
    if (!bucket) {
      bucket = {
        treasuryAccountId,
        accountName: treasuryName(row.treasury_accounts),
        total: 0,
        kinds: new Set(),
      }
      byAccount.set(treasuryAccountId, bucket)
    }
    bucket.total += amount
    bucket.kinds.add(kind)
    if (!bucket.accountName) {
      const name = treasuryName(row.treasury_accounts)
      if (name) bucket.accountName = name
    }
  }

  const result: SessionCloseCobro[] = []
  for (const bucket of byAccount.values()) {
    result.push({
      key: treasuryCloseAccountKey(bucket.treasuryAccountId),
      treasuryAccountId: bucket.treasuryAccountId,
      paymentKind: [...bucket.kinds].sort()[0] ?? "other",
      accountName: bucket.accountName,
      label: bucket.accountName ?? "Cuenta",
      total: roundMoney(bucket.total),
    })
  }
  for (const [key, bucket] of unassigned) {
    result.push({
      key,
      treasuryAccountId: null,
      paymentKind: bucket.paymentKind,
      accountName: null,
      label: operationPaymentKindLabel(bucket.paymentKind),
      total: roundMoney(bucket.total),
    })
  }
  return result.sort((a, b) => a.label.localeCompare(b.label, "es"))
}

export function cobrosByTreasuryLineFromPayments(
  payRows: SalePaymentRow[],
): SessionTreasuryLineCobro[] {
  const buckets = new Map<
    string,
    {
      treasuryAccountId: string | null
      paymentKind: string
      accountName: string | null
      total: number
    }
  >()
  for (const row of payRows) {
    const kind = String(row.payment_kind ?? "other")
    if (kind === "cash") continue
    const amount = parseMoney(row.amount)
    if (amount <= 0) continue
    const treasuryAccountId =
      row.treasury_account_id != null ? String(row.treasury_account_id) : null
    const accountName = treasuryName(row.treasury_accounts)
    const key = treasuryCloseLineKey(treasuryAccountId, kind)
    const existing = buckets.get(key)
    if (existing) existing.total += amount
    else {
      buckets.set(key, {
        treasuryAccountId,
        paymentKind: kind,
        accountName,
        total: amount,
      })
    }
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      treasuryAccountId: bucket.treasuryAccountId,
      paymentKind: bucket.paymentKind,
      accountName: bucket.accountName,
      label: formatTreasuryCloseLineLabel(bucket.accountName, bucket.paymentKind),
      total: roundMoney(bucket.total),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"))
}

export function cobrosByKindFromPayments(
  payRows: SalePaymentRow[],
): Map<string, SessionPaymentKindCobro> {
  const buckets = new Map<
    string,
    { total: number; byTreasury: Map<string, number> }
  >()
  for (const row of payRows) {
    const kind = String(row.payment_kind ?? "other")
    if (kind === "cash") continue
    const amount = parseMoney(row.amount)
    if (amount <= 0) continue
    const treasuryAccountId =
      row.treasury_account_id != null ? String(row.treasury_account_id) : null
    let bucket = buckets.get(kind)
    if (!bucket) {
      bucket = { total: 0, byTreasury: new Map() }
      buckets.set(kind, bucket)
    }
    bucket.total += amount
    if (treasuryAccountId) {
      bucket.byTreasury.set(
        treasuryAccountId,
        (bucket.byTreasury.get(treasuryAccountId) ?? 0) + amount,
      )
    }
  }
  const result = new Map<string, SessionPaymentKindCobro>()
  for (const [kind, bucket] of buckets) {
    let primaryTreasuryAccountId: string | null = null
    let maxAmount = 0
    for (const [taId, amount] of bucket.byTreasury) {
      if (amount > maxAmount) {
        maxAmount = amount
        primaryTreasuryAccountId = taId
      }
    }
    result.set(kind, {
      total: roundMoney(bucket.total),
      primaryTreasuryAccountId,
    })
  }
  return result
}

export async function loadSessionCobrosForClose(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<SessionCloseCobro[]> {
  const sales = await loadCompletedSalesForSessions(supabase, popId, [sessionId])
  const payments = await loadSalePaymentsForSaleIds(
    supabase,
    popId,
    sales.map((s) => s.id),
    false,
  )
  return cobrosForCloseFromPayments(payments)
}

export async function loadSessionCobrosByTreasuryLine(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<SessionTreasuryLineCobro[]> {
  const sales = await loadCompletedSalesForSessions(supabase, popId, [sessionId])
  const payments = await loadSalePaymentsForSaleIds(
    supabase,
    popId,
    sales.map((s) => s.id),
    false,
  )
  return cobrosByTreasuryLineFromPayments(payments)
}

export async function loadSessionNonCashCobrosByKind(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<Map<string, SessionPaymentKindCobro>> {
  const sales = await loadCompletedSalesForSessions(supabase, popId, [sessionId])
  const payments = await loadSalePaymentsForSaleIds(
    supabase,
    popId,
    sales.map((s) => s.id),
    false,
  )
  return cobrosByKindFromPayments(payments)
}

export async function loadCobrosTurnoPorMedio(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<{
  totalCobrado: number
  porMedio: { name: string; kind: string; total: number }[]
}> {
  const sales = await loadCompletedSalesForSessions(supabase, popId, [sessionId])
  let totalCobrado = roundMoney(sales.reduce((sum, s) => sum + s.total, 0))
  const payments = await loadSalePaymentsForSaleIds(
    supabase,
    popId,
    sales.map((s) => s.id),
    true,
  )
  const sums = new Map<string, number>()
  for (const row of payments) {
    const kind = String(row.payment_kind ?? "other")
    sums.set(kind, (sums.get(kind) ?? 0) + parseMoney(row.amount))
  }
  const { data: receiptRows } = await supabase
    .from("current_account_receipts")
    .select("payment_kind, amount")
    .eq("pop_id", popId)
    .eq("cash_register_session_id", sessionId)
    .eq("direction", "receivable")
  for (const row of receiptRows || []) {
    const kind = String(row.payment_kind ?? "other")
    const amount = parseMoney(row.amount)
    if (!(amount > 0)) continue
    sums.set(kind, (sums.get(kind) ?? 0) + amount)
    totalCobrado += amount
  }
  totalCobrado = roundMoney(totalCobrado)
  const porMedio = [...sums.entries()]
    .map(([kind, total]) => ({
      name: operationPaymentKindLabel(kind),
      kind,
      total: roundMoney(total),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
  return { totalCobrado, porMedio }
}
