import type { SupabaseClient } from "@supabase/supabase-js"
import { loadUserDisplayNames } from "../operations/loaders.js"
import { OPERATION_PAYMENT_KINDS } from "../operations/paymentLabels.js"
import { canCloseCashRegisterSession } from "./access.js"
import type {
  ArcaSalePointOption,
  CashRegisterListRow,
  CashRegistersFormContext,
  CashTreasuryAccountOption,
} from "./schema.js"

type ListResult =
  | { success: true; data: { registers: CashRegisterListRow[] } }
  | { success: false; error: string }

export async function listCashRegisters(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  keys: readonly string[],
  isOwner: boolean,
): Promise<ListResult> {
  const { data: regs, error: regErr } = await supabase
    .from("cash_registers")
    .select(
      "id, name, sort_order, is_active, cash_treasury_account_id, arca_sale_point_id",
    )
    .eq("pop_id", popId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (regErr) {
    return {
      success: false,
      error: regErr.message || "No se pudieron cargar las cajas.",
    }
  }

  const { data: openSessions, error: sessErr } = await supabase
    .from("cash_register_sessions")
    .select("id, cash_register_id, opening_cash, opened_at, opened_by, note")
    .eq("pop_id", popId)
    .eq("status", "open")
  if (sessErr) {
    return {
      success: false,
      error: sessErr.message || "No se pudieron cargar los turnos.",
    }
  }

  const openByRegister = new Map<
    string,
    {
      id: string
      opened_at: string
      opened_by: string | null
      note: string | null
    }
  >()
  for (const s of openSessions || []) {
    openByRegister.set(String(s.cash_register_id), {
      id: String(s.id),
      opened_at: String(s.opened_at ?? ""),
      opened_by: s.opened_by != null ? String(s.opened_by) : null,
      note: s.note != null ? String(s.note) : null,
    })
  }

  const openUserNames = await loadUserDisplayNames(
    supabase,
    [...openByRegister.values()].map((s) => s.opened_by).filter(Boolean) as string[],
  )

  const arqueoNumberBySessionId = new Map<string, number>()
  await Promise.all(
    [...openByRegister.entries()].map(async ([registerId, open]) => {
      const { count } = await supabase
        .from("cash_register_sessions")
        .select("id", { count: "exact", head: true })
        .eq("pop_id", popId)
        .eq("cash_register_id", registerId)
        .lte("opened_at", open.opened_at)
      arqueoNumberBySessionId.set(open.id, count ?? 0)
    }),
  )

  const { data: salePointRows } = await supabase
    .from("arca_sale_points")
    .select("id, pto_vta")
    .eq("pop_id", popId)
  const ptoVtaById = new Map(
    (salePointRows || []).map((row) => [String(row.id), Number(row.pto_vta)]),
  )

  const registers: CashRegisterListRow[] = (regs || []).map((r) => {
    const id = String(r.id)
    const open = openByRegister.get(id)
    const arcaSalePointId =
      r.arca_sale_point_id != null ? String(r.arca_sale_point_id) : null
    return {
      id,
      name: String(r.name ?? ""),
      sortOrder: Number(r.sort_order ?? 0) || 0,
      isActive: Boolean(r.is_active),
      cashTreasuryAccountId:
        r.cash_treasury_account_id != null
          ? String(r.cash_treasury_account_id)
          : null,
      arcaSalePointId,
      arcaPtoVta: arcaSalePointId
        ? (ptoVtaById.get(arcaSalePointId) ?? null)
        : null,
      openSessionId: open?.id ?? null,
      canCloseOpenSession: open
        ? canCloseCashRegisterSession({
            currentUserId: userId,
            openedByUserId: open.opened_by,
            keys,
            isOwner,
          })
        : false,
      cashBalance: null,
      openedAt: open?.opened_at ?? null,
      openSessionMeta: open
        ? {
            arqueoNumber: arqueoNumberBySessionId.get(open.id) ?? 0,
            openedByUserId: open.opened_by,
            openedByName: open.opened_by
              ? (openUserNames.get(open.opened_by) ?? "Usuario")
              : null,
            openingNote: open.note?.trim() ? open.note.trim() : null,
          }
        : null,
      openSessionTotals: null,
    }
  })

  return { success: true, data: { registers } }
}

export async function getCashRegistersFormContext(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  { success: true; data: CashRegistersFormContext } | { success: false; error: string }
> {
  const { data: cashTaRows, error: cashTaErr } = await supabase
    .from("treasury_accounts")
    .select("id, name, sort_order")
    .eq("pop_id", popId)
    .eq("kind", "cash")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (cashTaErr) {
    return {
      success: false,
      error: cashTaErr.message || "No se pudieron cargar las cuentas de efectivo.",
    }
  }

  const cashTreasuryAccounts: CashTreasuryAccountOption[] = (cashTaRows || []).map(
    (row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
    }),
  )

  const { data: salePointRows } = await supabase
    .from("arca_sale_points")
    .select(
      "id, pto_vta, certificate_crt_uploaded_at, certificate_key_uploaded_at",
    )
    .eq("pop_id", popId)
    .order("pto_vta", { ascending: true })
  const salePoints: ArcaSalePointOption[] = (salePointRows || []).map((row) => ({
    id: String(row.id),
    ptoVta: Number(row.pto_vta),
    configured: Boolean(
      row.certificate_crt_uploaded_at && row.certificate_key_uploaded_at,
    ),
  }))

  return {
    success: true,
    data: {
      cashTreasuryAccounts,
      salePoints,
      paymentMethods: OPERATION_PAYMENT_KINDS.filter((k) => k.value !== "cash").map(
        (k) => ({ kind: k.value, label: k.label }),
      ),
    },
  }
}
