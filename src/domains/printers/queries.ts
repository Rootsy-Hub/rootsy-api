import type { SupabaseClient } from "@supabase/supabase-js"
import {
  normalizePrinterFields,
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
): Promise<
  | { success: true; data: PrinterRow }
  | { success: false; error: string; status?: 400 }
> {
  const fields = normalizePrinterFields(input)
  const { data, error } = await supabase
    .from("pop_printers")
    .insert({
      pop_id: popId,
      name: fields.name,
      is_active: fields.isActive,
      sort_order: fields.sortOrder,
      integration_kind: fields.integrationKind,
      connection_hint: fields.connectionHint,
    })
    .select(SELECT)
    .single()
  if (error || !data) {
    return {
      success: false,
      error: printerWriteError(error?.message || "No se pudo crear."),
      status: 400,
    }
  }
  return { success: true, data: mapRow(data as PrinterDbRow) }
}

export async function updatePrinter(
  supabase: SupabaseClient,
  popId: string,
  printerId: string,
  input: UpsertPrinterBody,
): Promise<
  | { success: true; data: PrinterRow }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const fields = normalizePrinterFields(input)
  const { data, error } = await supabase
    .from("pop_printers")
    .update({
      name: fields.name,
      is_active: fields.isActive,
      sort_order: fields.sortOrder,
      integration_kind: fields.integrationKind,
      connection_hint: fields.connectionHint,
    })
    .eq("id", printerId)
    .eq("pop_id", popId)
    .select(SELECT)
    .maybeSingle()
  if (error) {
    return {
      success: false,
      error: printerWriteError(error.message),
      status: 400,
    }
  }
  if (!data) {
    return { success: false, error: "Impresora no encontrada.", status: 404 }
  }
  return { success: true, data: mapRow(data as PrinterDbRow) }
}

export async function deletePrinter(
  supabase: SupabaseClient,
  popId: string,
  printerId: string,
): Promise<
  { success: true } | { success: false; error: string; status: 404 | 500 }
> {
  const existing = await getPrinter(supabase, popId, printerId)
  if (!existing.success) return existing
  const { error } = await supabase
    .from("pop_printers")
    .delete()
    .eq("id", printerId)
    .eq("pop_id", popId)
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo eliminar.",
      status: 500,
    }
  }
  return { success: true }
}
