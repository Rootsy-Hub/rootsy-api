import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { mergePatch } from "../../lib/patchBody.js"
import {
  auditedDelete,
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import {
  normalizeCurrentAccountCreditLimit,
  normalizeCurrentAccountTermDays,
  SUPPLIER_TABLE_SELECT,
} from "./queries.js"
import {
  SUPPLIER_IVA_CONDITION_VALUES,
  type PatchSupplierBody,
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
  const row: Record<string, unknown> = {
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
  }
  if (input.currentAccountEnabled) {
    row.current_account_credit_limit = normalizeCurrentAccountCreditLimit(
      parseMoneyInput(input.currentAccountCreditLimit, 0),
    )
    row.current_account_term_days = normalizeCurrentAccountTermDays(
      input.currentAccountTermDays,
    )
  }
  return row
}

export async function createSupplier(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertSupplierBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre es obligatorio.", status: 400 }
  }
  const id = randomUUID()
  const row = { id, ...rowFromInput(input, popId) }
  const applied = await auditedInsert(supabase, {
    kind: "suppliers.create",
    table: "suppliers",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, id }
}

function supplierRowToUpsert(row: Record<string, unknown>): UpsertSupplierBody {
  const limit = normalizeCurrentAccountCreditLimit(
    row.current_account_credit_limit,
  )
  return {
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    taxId: String(row.tax_id ?? ""),
    notes: String(row.notes ?? ""),
    ivaCondition: String(row.iva_condition ?? ""),
    addressLine: String(row.address_line ?? ""),
    isActive: row.is_active !== false,
    currentAccountEnabled: row.current_account_enabled === true,
    currentAccountCreditLimit: limit != null ? String(limit) : "",
    currentAccountTermDays: String(
      normalizeCurrentAccountTermDays(row.current_account_term_days),
    ),
  }
}

export async function updateSupplier(
  supabase: SupabaseClient,
  popId: string,
  supplierId: string,
  patch: PatchSupplierBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: current, error: fetchError } = await supabase
    .from("suppliers")
    .select(SUPPLIER_TABLE_SELECT)
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
  if (!current) {
    return { success: false, error: "No se encontró el proveedor.", status: 404 }
  }
  const input = mergePatch(
    supplierRowToUpsert(current as Record<string, unknown>),
    patch,
  )

  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre es obligatorio.", status: 400 }
  }
  const updatePayload = rowFromInput(input, popId)
  const { pop_id: _popId, ...updateRow } = updatePayload
  const applied = await auditedUpdate(supabase, {
    kind: "suppliers.patch",
    table: "suppliers",
    id: supplierId,
    row: updateRow,
    ctx: audit,
    popId,
    previous: current,
    next: { ...current, ...updateRow },
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status,
    }
  }
  return { success: true }
}

export async function deleteSupplier(
  supabase: SupabaseClient,
  popId: string,
  supplierId: string,
  confirmationTyped: string,
  audit: MutationAuditCtx,
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
  const applied = await auditedDelete(supabase, {
    kind: "suppliers.delete",
    table: "suppliers",
    id: supplierId,
    ctx: audit,
    popId,
    previous: supplier,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status,
    }
  }
  return { success: true }
}
