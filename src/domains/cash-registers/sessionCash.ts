import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "../reports/money.js"

export async function loadSessionCurrentAccountCash(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<{ inbound: number; outbound: number }> {
  const { data } = await supabase
    .from("current_account_receipts")
    .select("direction, amount, payment_kind")
    .eq("pop_id", popId)
    .eq("cash_register_session_id", sessionId)
    .eq("payment_kind", "cash")

  let inbound = 0
  let outbound = 0
  for (const row of data ?? []) {
    const amount = parseMoney(row.amount)
    if (!(amount > 0)) continue
    if (String(row.direction) === "payable") outbound += amount
    else inbound += amount
  }
  return {
    inbound: roundMoney(inbound),
    outbound: roundMoney(outbound),
  }
}

export async function loadSessionsCurrentAccountCash(
  supabase: SupabaseClient,
  popId: string,
  sessionIds: string[],
): Promise<Map<string, { inbound: number; outbound: number }>> {
  const map = new Map<string, { inbound: number; outbound: number }>()
  for (const id of sessionIds) map.set(id, { inbound: 0, outbound: 0 })
  if (sessionIds.length === 0) return map

  const { data } = await supabase
    .from("current_account_receipts")
    .select("cash_register_session_id, direction, amount, payment_kind")
    .eq("pop_id", popId)
    .in("cash_register_session_id", sessionIds)
    .eq("payment_kind", "cash")

  for (const row of data ?? []) {
    const sessionId = String(row.cash_register_session_id ?? "")
    const bucket = map.get(sessionId)
    if (!bucket) continue
    const amount = parseMoney(row.amount)
    if (!(amount > 0)) continue
    if (String(row.direction) === "payable") bucket.outbound += amount
    else bucket.inbound += amount
  }
  for (const [id, bucket] of map) {
    map.set(id, {
      inbound: roundMoney(bucket.inbound),
      outbound: roundMoney(bucket.outbound),
    })
  }
  return map
}

export async function computeEfectivoTeoricoSession(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<
  | {
      success: true
      teorico: number
      openingCash: number
      ventasEfectivo: number
      ingresosCajon: number
      egresosCajon: number
    }
  | { success: false; error: string }
> {
  const { data: sess, error: se } = await supabase
    .from("cash_register_sessions")
    .select("id, opening_cash, status")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (se || !sess?.id) {
    return { success: false, error: "No se pudo leer la sesión de caja." }
  }
  if (String(sess.status) !== "open") {
    return { success: false, error: "La sesión no está abierta." }
  }
  const openingCash = parseMoney(sess.opening_cash)
  const { data: saleRows } = await supabase
    .from("sales")
    .select("id")
    .eq("pop_id", popId)
    .eq("cash_register_session_id", sessionId)
    .eq("status", "completed")
  const saleIds = (saleRows || []).map((r) => String(r.id))
  let ventasEfectivo = 0
  if (saleIds.length > 0) {
    const { data: osp } = await supabase
      .from("sale_payments")
      .select("payment_kind, amount")
      .eq("pop_id", popId)
      .is("reversed_at", null)
      .in("sale_id", saleIds)
    for (const row of osp || []) {
      if (String(row.payment_kind) === "cash") {
        ventasEfectivo += parseMoney(row.amount)
      }
    }
  }
  const ccCash = await loadSessionCurrentAccountCash(supabase, popId, sessionId)
  ventasEfectivo = roundMoney(ventasEfectivo + ccCash.inbound)
  const { data: movs } = await supabase
    .from("cash_register_movements")
    .select("kind, amount")
    .eq("session_id", sessionId)
    .eq("pop_id", popId)
  let ing = 0
  let eg = 0
  for (const m of movs || []) {
    const amt = parseMoney(m.amount)
    if (String(m.kind) === "deposit") ing += amt
    else if (String(m.kind) === "withdrawal") eg += amt
  }
  ing = roundMoney(ing)
  eg = roundMoney(eg + ccCash.outbound)
  return {
    success: true,
    teorico: roundMoney(openingCash + ventasEfectivo + ing - eg),
    openingCash,
    ventasEfectivo,
    ingresosCajon: ing,
    egresosCajon: eg,
  }
}

export async function computeCashBalance(
  supabase: SupabaseClient,
  sessionId: string,
  openingCash: number,
): Promise<number> {
  const { data, error } = await supabase
    .from("cash_register_movements")
    .select("kind, amount")
    .eq("session_id", sessionId)
  if (error || !data) return openingCash
  let bal = openingCash
  for (const row of data) {
    const amt = parseMoney(row.amount)
    if (String(row.kind) === "deposit") bal += amt
    else if (String(row.kind) === "withdrawal") bal -= amt
  }
  return roundMoney(bal)
}
