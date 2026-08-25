import type { SupabaseClient } from "@supabase/supabase-js"

export type OperateOpenCashSalePoint = {
  id: string
  ptoVta: number
}

export type OperateOpenCashSession = {
  sessionId: string
  cashRegisterId: string
  openedAt: string
  salePoint: OperateOpenCashSalePoint | null
}

type Result =
  | { success: true; data: { session: OperateOpenCashSession | null } }
  | { success: false; error: string }

function toIso(value: unknown): string | null {
  if (value == null) return null
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export async function getOperateOpenCashSession(
  supabase: SupabaseClient,
  popId: string,
  userId: string | null | undefined,
): Promise<Result> {
  if (!userId) {
    return { success: true, data: { session: null } }
  }

  const { data: sessionRow, error: sessErr } = await supabase
    .from("cash_register_sessions")
    .select("id, cash_register_id, opened_at")
    .eq("pop_id", popId)
    .eq("status", "open")
    .eq("opened_by", userId)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (sessErr) {
    return {
      success: false,
      error: sessErr.message || "No se pudo cargar el turno de caja.",
    }
  }
  if (!sessionRow) {
    return { success: true, data: { session: null } }
  }

  const cashRegisterId = String(sessionRow.cash_register_id)
  const { data: register, error: regErr } = await supabase
    .from("cash_registers")
    .select("id, arca_sale_point_id")
    .eq("pop_id", popId)
    .eq("id", cashRegisterId)
    .maybeSingle()
  if (regErr) {
    return {
      success: false,
      error: regErr.message || "No se pudo cargar la caja.",
    }
  }
  if (!register) {
    return { success: true, data: { session: null } }
  }

  let salePoint: OperateOpenCashSalePoint | null = null
  const salePointId = register.arca_sale_point_id
    ? String(register.arca_sale_point_id)
    : null
  if (salePointId) {
    const { data: point, error: pointErr } = await supabase
      .from("arca_sale_points")
      .select("id, pto_vta")
      .eq("pop_id", popId)
      .eq("id", salePointId)
      .maybeSingle()
    if (pointErr) {
      return {
        success: false,
        error: pointErr.message || "No se pudo cargar el punto de venta.",
      }
    }
    const ptoVta = Number(point?.pto_vta)
    if (point && Number.isFinite(ptoVta)) {
      salePoint = { id: String(point.id), ptoVta }
    }
  }

  const openedAt = toIso(sessionRow.opened_at)
  if (!openedAt) {
    return { success: true, data: { session: null } }
  }

  return {
    success: true,
    data: {
      session: {
        sessionId: String(sessionRow.id),
        cashRegisterId,
        openedAt,
        salePoint,
      },
    },
  }
}
