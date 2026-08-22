import type { SupabaseClient } from "@supabase/supabase-js"
import {
  normalizeCurrentAccountCreditLimit,
  normalizeCurrentAccountTermDays,
} from "./queries.js"
import {
  SUPPLIER_IVA_CONDITION_VALUES,
  type UpsertSupplierBody,
} from "./schema.js"

type MutateResult =
  | { success: true; id?: string }
  | { success: false; error: string; status: 400 | 404 | 500 }

function supplierDeleteConfirmPhrase(supplierName: string): string {
  const name = supplierName.trim() || "este proveedor"
  return `Eliminar ${name}`
}

function normalizeIvaCondition(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  return (SUPPLIER_IVA_CONDITION_VALUES as readonly string[]).includes(t)
    ? t
    : null
}

function parseMoneyInput(raw: string, fallback = 0): number {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  if (trimmed.includes(",")) {
    const normalized = trimmed.replace(/\./g, "").replace(",", ".")
    const n = Number.parseFloat(normalized)
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.round(n * 100) / 100
  }
  const digits = trimmed.replace(/\./g, "").replace(/\D/g, "")
  if (!digits) return fallback
  const n = Number.parseInt(digits, 10)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

function rowFromInput(input: UpsertSupplierBody, popId: string) {
  return {
    pop_id: popId,
    name: input.name.trim(),
    email: input.email.trim() || null,
    phone: input.phone.trim() || null,
    tax_id: input.taxId.trim() || null,
    notes: input.notes.trim() || null,
    iva_condition: normalizeIvaCondition(input.ivaCondition),
    address_line: input.addressLine.trim() || null,
    is_active: input.isActive,
    current_account_enabled: input.currentAccountEnabled,
    current_account_credit_limit: input.currentAccountEnabled
      ? normalizeCurrentAccountCreditLimit(
          parseMoneyInput(input.currentAccountCreditLimit, 0),
        )
      : undefined,
    current_account_term_days: input.currentAccountEnabled
      ? normalizeCurrentAccountTermDays(input.currentAccountTermDays)
      : undefined,
  }
}

export async function createSupplier(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertSupplierBody,
): Promise<MutateResult> {
  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre es obligatorio.", status: 400 }
  }
  const { error, data } = await supabase
    .from("suppliers")
    .insert(rowFromInput(input, popId))
    .select("id")
    .maybeSingle()
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo crear el proveedor.",
      status: 500,
    }
  }
  return { success: true, id: data?.id ? String(data.id) : undefined }
}

export async function updateSupplier(
  supabase: SupabaseClient,
  popId: string,
  supplierId: string,
  input: UpsertSupplierBody,
): Promise<MutateResult> {
  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre es obligatorio.", status: 400 }
  }
  const patch = rowFromInput(input, popId)
  const { pop_id: _popId, ...updateRow } = patch
  const { error } = await supabase
    .from("suppliers")
    .update(updateRow)
    .eq("id", supplierId)
    .eq("pop_id", popId)
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo guardar el proveedor.",
      status: 500,
    }
  }
  return { success: true }
}

export async function deleteSupplier(
  supabase: SupabaseClient,
  popId: string,
  supplierId: string,
  confirmationTyped: string,
): Promise<MutateResult> {
  const { data: supplier, error: fetchError } = await supabase
    .from("suppliers")
    .select("name")
    .eq("id", supplierId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return {
      success: false,
      error: fetchError.message || "No se encontró el proveedor.",
      status: 500,
    }
  }
  if (!supplier) {
    return { success: false, error: "No se encontró el proveedor.", status: 404 }
  }
  const expectedPhrase = supplierDeleteConfirmPhrase(String(supplier.name ?? ""))
  if (confirmationTyped.trim() !== expectedPhrase) {
    return {
      success: false,
      error: `Escribí (${expectedPhrase}) para confirmar el borrado.`,
      status: 400,
    }
  }
  const { error } = await supabase
    .from("suppliers")
    .delete()
    .eq("id", supplierId)
    .eq("pop_id", popId)
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo eliminar el proveedor.",
      status: 500,
    }
  }
  return { success: true }
}
