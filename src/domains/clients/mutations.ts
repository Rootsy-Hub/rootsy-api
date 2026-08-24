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
  CLIENT_SELECT,
  normalizeCurrentAccountCreditLimit,
  normalizeCurrentAccountTermDays,
} from "./queries.js"
import {
  CLIENT_IVA_CONDITION_VALUES,
  type PatchClientBody,
  type UpsertClientBody,
} from "./schema.js"

type MutateResult =
  | { success: true; id?: string }
  | { success: false; error: string; status: 400 | 404 | 500 }

const INTERNAL_COMPROBANTE = "Recibo X"
const FISCAL_COMPROBANTES = new Set(["Factura A", "Factura B", "Factura C"])

function clientDeleteConfirmPhrase(clientName: string): string {
  const name = clientName.trim() || "este cliente"
  return `Eliminar ${name}`
}

function normalizeIvaCondition(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  return (CLIENT_IVA_CONDITION_VALUES as readonly string[]).includes(t)
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

function hasValidPopFiscalCuit(raw: unknown): boolean {
  const digits = String(raw ?? "").replace(/\D/g, "")
  return digits.length === 11
}

function normalizeDefaultInvoiceTypeLabel(
  raw: string,
  hasValidFiscalCuit: boolean,
): string | null {
  const t = raw.trim()
  if (!t) return null
  if (t === INTERNAL_COMPROBANTE) return t
  if (FISCAL_COMPROBANTES.has(t) && hasValidFiscalCuit) return t
  return null
}

async function loadPopInvoiceContext(
  supabase: SupabaseClient,
  popId: string,
): Promise<{ hasValidFiscalCuit: boolean }> {
  const { data } = await supabase
    .from("pops")
    .select("fiscal_cuit")
    .eq("id", popId)
    .maybeSingle()
  return {
    hasValidFiscalCuit: hasValidPopFiscalCuit(data?.fiscal_cuit),
  }
}

function rowFromInput(
  input: UpsertClientBody,
  popId: string,
  hasValidFiscalCuit: boolean,
) {
  const name = input.name.trim()
  return {
    pop_id: popId,
    name,
    email: input.email.trim() || null,
    phone: input.phone.trim() || null,
    tax_id: input.taxId.trim() || null,
    notes: input.notes.trim() || null,
    iva_condition: normalizeIvaCondition(input.ivaCondition),
    address_line: input.addressLine.trim() || null,
    default_invoice_type_label: normalizeDefaultInvoiceTypeLabel(
      input.defaultInvoiceTypeLabel,
      hasValidFiscalCuit,
    ),
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

export async function createClient(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertClientBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre es obligatorio.", status: 400 }
  }
  const ctx = await loadPopInvoiceContext(supabase, popId)
  const id = randomUUID()
  const row = { id, ...rowFromInput(input, popId, ctx.hasValidFiscalCuit) }
  const applied = await auditedInsert(supabase, {
    kind: "clients.create",
    table: "clients",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, id }
}

function clientRowToUpsert(row: Record<string, unknown>): UpsertClientBody {
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
    defaultInvoiceTypeLabel: String(row.default_invoice_type_label ?? ""),
    isActive: Boolean(row.is_active ?? true),
    currentAccountEnabled: row.current_account_enabled === true,
    currentAccountCreditLimit: limit != null ? String(limit) : "",
    currentAccountTermDays: String(
      normalizeCurrentAccountTermDays(row.current_account_term_days),
    ),
  }
}

export async function updateClient(
  supabase: SupabaseClient,
  popId: string,
  clientId: string,
  patch: PatchClientBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: current, error: fetchError } = await supabase
    .from("clients")
    .select(CLIENT_SELECT)
    .eq("id", clientId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return {
      success: false,
      error: fetchError.message || "No se encontró el cliente.",
      status: 500,
    }
  }
  if (!current) {
    return { success: false, error: "No se encontró el cliente.", status: 404 }
  }
  const input = mergePatch(
    clientRowToUpsert(current as Record<string, unknown>),
    patch,
  )

  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre es obligatorio.", status: 400 }
  }
  const ctx = await loadPopInvoiceContext(supabase, popId)
  const updatePayload = rowFromInput(input, popId, ctx.hasValidFiscalCuit)
  const { pop_id: _popId, ...updateRow } = updatePayload
  const applied = await auditedUpdate(supabase, {
    kind: "clients.patch",
    table: "clients",
    id: clientId,
    row: updateRow as Record<string, unknown>,
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

export async function deleteClient(
  supabase: SupabaseClient,
  popId: string,
  clientId: string,
  confirmationTyped: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: client, error: fetchError } = await supabase
    .from("clients")
    .select("name")
    .eq("id", clientId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return {
      success: false,
      error: fetchError.message || "No se encontró el cliente.",
      status: 500,
    }
  }
  if (!client) {
    return { success: false, error: "No se encontró el cliente.", status: 404 }
  }
  const expectedPhrase = clientDeleteConfirmPhrase(String(client.name ?? ""))
  if (confirmationTyped.trim() !== expectedPhrase) {
    return {
      success: false,
      error: `Escribí (${expectedPhrase}) para confirmar el borrado.`,
      status: 400,
    }
  }
  const applied = await auditedDelete(supabase, {
    kind: "clients.delete",
    table: "clients",
    id: clientId,
    ctx: audit,
    popId,
    previous: client,
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
