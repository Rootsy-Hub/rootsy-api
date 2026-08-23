import type { SupabaseClient } from "@supabase/supabase-js"
import type { SaleOpenCashSession } from "./schema.js"

type CashRegisterRow = {
  id: string
  name: string | null
  sort_order: number | null
  cash_treasury_account_id: string | null
}

type OpenSessionRow = {
  id: string
  cash_register_id: string
  opened_by: string
}

export async function resolveOpenCashSession(
  supabase: SupabaseClient,
  popId: string,
  userId?: string | null,
): Promise<SaleOpenCashSession | null> {
  const { data: regs, error: regErr } = await supabase
    .from("cash_registers")
    .select("id, name, sort_order, cash_treasury_account_id")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })

  if (regErr) return null

  const { data: sessions, error: sessErr } = await supabase
    .from("cash_register_sessions")
    .select("id, cash_register_id, opened_by")
    .eq("pop_id", popId)
    .eq("status", "open")

  if (sessErr) return null

  const openByReg = new Map<string, OpenSessionRow>()
  for (const s of sessions || []) {
    openByReg.set(String(s.cash_register_id), {
      id: String(s.id),
      cash_register_id: String(s.cash_register_id),
      opened_by: String(s.opened_by),
    })
  }

  const openEntries: {
    register: CashRegisterRow
    session: OpenSessionRow
  }[] = []

  for (const r of (regs || []) as CashRegisterRow[]) {
    const session = openByReg.get(String(r.id))
    if (session) openEntries.push({ register: r, session })
  }

  if (openEntries.length === 0) return null

  const pick =
    (userId
      ? openEntries.find((e) => e.session.opened_by === userId)
      : undefined) ?? openEntries[0]

  const cashTreasuryAccountId = pick.register.cash_treasury_account_id
    ? String(pick.register.cash_treasury_account_id)
    : null
  if (!cashTreasuryAccountId) return null

  return {
    sessionId: pick.session.id,
    cashRegisterId: String(pick.register.id),
    registerName: String(pick.register.name ?? ""),
    cashTreasuryAccountId,
  }
}
