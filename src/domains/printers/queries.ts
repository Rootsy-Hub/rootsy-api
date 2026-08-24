import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  auditedDelete,
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { mergePatch } from "../../lib/patchBody.js"
import {
  normalizePrinterFields,
  type PatchPrinterBody,
  type PrinterRow,
  type UpsertPrinterBody,
} from "./schema.js"

const SELECT =
  "id, name, is_active, sort_order, integration_kind, connection_hint"

type PrinterDbRow = {
  id: string
  name: string
  is_active: boolean
  sort_order: number
  integration_kind: string | null
  connection_hint: string | null
}

function mapRow(row: PrinterDbRow): PrinterRow {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order ?? 0) || 0,
    integrationKind:
      row.integration_kind != null && String(row.integration_kind).trim()
        ? String(row.integration_kind)
        : null,
    connectionHint:
      row.connection_hint != null && String(row.connection_hint).trim()
        ? String(row.connection_hint)
        : null,
  }
}

function printerWriteError(message: string): string {
  if (/pop_printers.*unique|duplicate key/i.test(message)) {
    return "Ya existe una impresora con ese nombre."
  }
  return message
}

function uniqueStatus(message: string): 400 | 500 {
  return /pop_printers.*unique|duplicate key/i.test(message) ? 400 : 500
}

export async function listPrinters(
  supabase: SupabaseClient,
  popId: string,
): Promise<{ success: true; data: PrinterRow[] } | { success: false; error: string }> {
  const { data, error } = await supabase
    .from("pop_printers")
    .select(SELECT)
    .eq("pop_id", popId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudieron cargar las impresoras.",
    }
  }
  return {
    success: true,
    data: (data || []).map((row) => mapRow(row as PrinterDbRow)),
  }
}

export async function getPrinter(
  supabase: SupabaseClient,
  popId: string,
  printerId: string,
): Promise<
  | { success: true; data: PrinterRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("pop_printers")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("id", printerId)
    .maybeSingle()
  if (error) {
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    return { success: false, error: "Impresora no encontrada.", status: 404 }
  }
  return { success: true, data: mapRow(data as PrinterDbRow) }
}

export async function createPrinter(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertPrinterBody,
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: PrinterRow }
  | { success: false; error: string; status?: 400 }
> {
  const fields = normalizePrinterFields(input)
  const id = randomUUID()
  const row = {
    id,
    pop_id: popId,
    name: fields.name,
    is_active: fields.isActive,
    sort_order: fields.sortOrder,
    integration_kind: fields.integrationKind,
    connection_hint: fields.connectionHint,
  }
  const applied = await auditedInsert(supabase, {
    kind: "printers.create",
    table: "pop_printers",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return {
      success: false,
      error: printerWriteError(applied.error),
      status: 400,
    }
  }
  return { success: true, data: mapRow(row) }
}

function printerToUpsertBody(row: PrinterRow): UpsertPrinterBody {
  return {
    name: row.name,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    integrationKind: row.integrationKind ?? "",
    connectionHint: row.connectionHint ?? "",
  }
}

export async function updatePrinter(
  supabase: SupabaseClient,
  popId: string,
  printerId: string,
  patch: PatchPrinterBody,
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: PrinterRow }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const current = await getPrinter(supabase, popId, printerId)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(printerToUpsertBody(current.data), patch)
  const fields = normalizePrinterFields(input)
  const updateRow = {
    name: fields.name,
    is_active: fields.isActive,
    sort_order: fields.sortOrder,
    integration_kind: fields.integrationKind,
    connection_hint: fields.connectionHint,
  }
  const next: PrinterDbRow = {
    id: printerId,
    ...updateRow,
  }
  const applied = await auditedUpdate(supabase, {
    kind: "printers.patch",
    table: "pop_printers",
    id: printerId,
    row: updateRow,
    ctx: audit,
    popId,
    previous: {
      id: current.data.id,
      name: current.data.name,
      is_active: current.data.isActive,
      sort_order: current.data.sortOrder,
      integration_kind: current.data.integrationKind,
      connection_hint: current.data.connectionHint,
    },
    next,
  })
  if (!applied.success) {
    const unique = uniqueStatus(applied.error)
    return {
      success: false,
      error: printerWriteError(applied.error),
      status: unique === 400 ? 400 : applied.status,
    }
  }
  return { success: true, data: mapRow(next) }
}

export async function deletePrinter(
  supabase: SupabaseClient,
  popId: string,
  printerId: string,
  audit: MutationAuditCtx,
): Promise<
  { success: true } | { success: false; error: string; status: 404 | 500 }
> {
  const existing = await getPrinter(supabase, popId, printerId)
  if (!existing.success) return existing
  const applied = await auditedDelete(supabase, {
    kind: "printers.delete",
    table: "pop_printers",
    id: printerId,
    ctx: audit,
    popId,
    previous: existing.data,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error || "No se pudo eliminar.",
      status: applied.status === 404 ? 404 : 500,
    }
  }
  return { success: true }
}
