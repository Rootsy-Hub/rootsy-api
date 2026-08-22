import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney } from "../reports/money.js"
import type {
  AddMovementBody,
  CreateCashRegisterBody,
  OpenSessionBody,
  UpdateCashRegisterBody,
} from "./schema.js"
import { computeCashBalance } from "./sessionCash.js"

type MutateResult =
  | { success: true; registerId?: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

async function resolveArcaSalePointId(
  supabase: SupabaseClient,
  popId: string,
  raw: string | null | undefined,
): Promise<
  { success: true; id: string | null } | { success: false; error: string; status: 400 }
> {
  const value = (raw ?? "").trim()
  if (!value || value === "none") return { success: true, id: null }
  const { data, error } = await supabase
    .from("arca_sale_points")
    .select("id")
    .eq("id", value)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error || !data?.id) {
    return {
      success: false,
      error: "Ese punto de venta no existe en este negocio.",
      status: 400,
    }
  }
  return { success: true, id: String(data.id) }
}

async function resolveCashTreasuryAccountId(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
): Promise<
  { success: true; id: string } | { success: false; error: string; status: 400 }
> {
  const { data, error } = await supabase
    .from("treasury_accounts")
    .select("id, kind, is_active")
    .eq("id", treasuryAccountId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error || !data?.id) {
    return {
      success: false,
      error: "Elegí una cuenta de efectivo destino.",
      status: 400,
    }
  }
  if (String(data.kind) !== "cash" || !data.is_active) {
    return {
      success: false,
      error: "Elegí una cuenta de efectivo activa.",
      status: 400,
    }
  }
  return { success: true, id: String(data.id) }
}

export async function createCashRegister(
  supabase: SupabaseClient,
  popId: string,
  input: CreateCashRegisterBody,
): Promise<MutateResult> {
  const cashTa = await resolveCashTreasuryAccountId(
    supabase,
    popId,
    input.cashTreasuryAccountId,
  )
  if (!cashTa.success) return cashTa
  const salePoint = await resolveArcaSalePointId(
    supabase,
    popId,
    input.arcaSalePointId,
  )
  if (!salePoint.success) return salePoint

  const { data: inserted, error } = await supabase
    .from("cash_registers")
    .insert({
      pop_id: popId,
      name: input.name,
      sort_order: input.sortOrder,
      is_active: true,
      cash_treasury_account_id: cashTa.id,
      arca_sale_point_id: salePoint.id,
    })
    .select("id")
    .single()
  if (error || !inserted?.id) {
    return {
      success: false,
      error: error?.message || "No se pudo crear la caja.",
      status: 500,
    }
  }
  return { success: true, registerId: String(inserted.id) }
}

export async function updateCashRegister(
  supabase: SupabaseClient,
  popId: string,
  registerId: string,
  input: UpdateCashRegisterBody,
): Promise<MutateResult> {
  const cashTa = await resolveCashTreasuryAccountId(
    supabase,
    popId,
    input.cashTreasuryAccountId,
  )
  if (!cashTa.success) return cashTa
  const salePoint = await resolveArcaSalePointId(
    supabase,
    popId,
    input.arcaSalePointId,
  )
  if (!salePoint.success) return salePoint

  const { data, error } = await supabase
    .from("cash_registers")
    .update({
      name: input.name,
      sort_order: input.sortOrder,
      is_active: input.isActive,
      cash_treasury_account_id: cashTa.id,
      arca_sale_point_id: salePoint.id,
    })
    .eq("id", registerId)
    .eq("pop_id", popId)
    .select("id")
    .maybeSingle()
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo guardar la caja.",
      status: 500,
    }
  }
  if (!data?.id) {
    return { success: false, error: "Caja no encontrada.", status: 404 }
  }
  return { success: true }
}

export async function deleteCashRegister(
  supabase: SupabaseClient,
  popId: string,
  registerId: string,
): Promise<MutateResult> {
  const { data: open } = await supabase
    .from("cash_register_sessions")
    .select("id")
    .eq("pop_id", popId)
    .eq("cash_register_id", registerId)
    .eq("status", "open")
    .maybeSingle()
  if (open) {
    return {
      success: false,
      error: "Cerrá el turno antes de eliminar la caja.",
      status: 409,
    }
  }
  const { data, error } = await supabase
    .from("cash_registers")
    .delete()
    .eq("id", registerId)
    .eq("pop_id", popId)
    .select("id")
    .maybeSingle()
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo eliminar la caja.",
      status: 500,
    }
  }
  if (!data?.id) {
    return { success: false, error: "Caja no encontrada.", status: 404 }
  }
  return { success: true }
}

export async function openCashSession(
  supabase: SupabaseClient,
  popId: string,
  registerId: string,
  userId: string,
  input: OpenSessionBody,
): Promise<MutateResult> {
  const { data: regRow, error: regErr } = await supabase
    .from("cash_registers")
    .select("id, cash_treasury_account_id")
    .eq("id", registerId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (regErr || !regRow?.id) {
    return { success: false, error: "Caja no encontrada.", status: 404 }
  }
  if (!regRow.cash_treasury_account_id) {
    return {
      success: false,
      error:
        "Configurá la cuenta de efectivo destino en esta caja antes de abrir el turno.",
      status: 400,
    }
  }
  const { data: alreadyOpen } = await supabase
    .from("cash_register_sessions")
    .select("id")
    .eq("pop_id", popId)
    .eq("cash_register_id", registerId)
    .eq("status", "open")
    .maybeSingle()
  if (alreadyOpen) {
    return {
      success: false,
      error: "Esta caja ya tiene un turno abierto.",
      status: 409,
    }
  }

  const noteTrim = input.note?.trim() ?? ""
  const { error } = await supabase.from("cash_register_sessions").insert({
    pop_id: popId,
    cash_register_id: registerId,
    status: "open",
    opened_by: userId,
    opening_cash: parseMoney(input.openingCash),
    note: noteTrim.length > 0 ? noteTrim : null,
  })
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo abrir el turno.",
      status: 500,
    }
  }
  return { success: true }
}

export async function addCashMovement(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
  userId: string,
  input: AddMovementBody,
): Promise<MutateResult> {
  const amount = parseMoney(input.amount)
  const { data: sess } = await supabase
    .from("cash_register_sessions")
    .select("opening_cash")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()
  if (!sess) {
    return { success: false, error: "El turno no está abierto.", status: 409 }
  }
  const opening = parseMoney(sess.opening_cash)
  const bal = await computeCashBalance(supabase, sessionId, opening)
  if (input.kind === "withdrawal" && amount > bal) {
    return {
      success: false,
      error: "El retiro supera el efectivo en caja.",
      status: 400,
    }
  }
  const note = input.note?.trim() ?? ""
  const { error } = await supabase.from("cash_register_movements").insert({
    pop_id: popId,
    session_id: sessionId,
    kind: input.kind,
    amount,
    note: note.length > 0 ? note : null,
    created_by: userId,
  })
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo guardar el movimiento.",
      status: 500,
    }
  }
  return { success: true }
}
