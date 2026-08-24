import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  auditedDelete,
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import type { PriceListRow } from "./schema.js"

const SELECT = "id, name, is_default, sort_order"

type PriceListDbRow = {
  id: string
  name: string
  is_default: boolean
  sort_order: number
}

function mapRow(row: PriceListDbRow): PriceListRow {
  return {
    id: String(row.id),
    name: String(row.name ?? "").trim(),
    isDefault: row.is_default === true,
    sortOrder: Number(row.sort_order ?? 0) || 0,
  }
}

function uniqueNameError(message: string) {
  if (/duplicate key|unique constraint|23505/i.test(message)) {
    return { error: "Ya existe una lista con ese nombre.", status: 409 as const }
  }
  return { error: message || "No se pudo guardar.", status: 500 as const }
}

async function ensureDefaultList(
  supabase: SupabaseClient,
  popId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc("ensure_pop_default_price_list", {
    p_pop_id: popId,
  })
  if (error) {
    return {
      ok: false,
      error: error.message || "No se pudo crear la lista principal.",
    }
  }
  return { ok: true }
}

export async function listPriceLists(
  supabase: SupabaseClient,
  popId: string,
): Promise<{ success: true; data: PriceListRow[] } | { success: false; error: string }> {
  const ensured = await ensureDefaultList(supabase, popId)
  if (!ensured.ok) return { success: false, error: ensured.error }

  const { data, error } = await supabase
    .from("price_lists")
    .select(SELECT)
    .eq("pop_id", popId)
    .order("is_default", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })

  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: (data ?? []).map((row) => mapRow(row as PriceListDbRow)),
  }
}

export async function createPriceList(
  supabase: SupabaseClient,
  popId: string,
  input: { name: string },
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: PriceListRow }
  | { success: false; error: string; status: 409 | 500 }
> {
  const { data: maxRow } = await supabase
    .from("price_lists")
    .select("sort_order")
    .eq("pop_id", popId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()
  const sortOrder =
    maxRow?.sort_order != null ? Number(maxRow.sort_order) + 1 : 1

  const id = randomUUID()
  const row: PriceListDbRow & { pop_id: string } = {
    id,
    pop_id: popId,
    name: input.name,
    is_default: false,
    sort_order: sortOrder,
  }
  const applied = await auditedInsert(supabase, {
    kind: "price-lists.create",
    table: "price_lists",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    const mapped = uniqueNameError(applied.error)
    return { success: false, error: mapped.error, status: mapped.status }
  }
  return { success: true, data: mapRow(row) }
}

export async function updatePriceList(
  supabase: SupabaseClient,
  popId: string,
  listId: string,
  input: { name: string },
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: PriceListRow }
  | { success: false; error: string; status: 404 | 409 | 500 }
> {
  const { data: current, error: fetchError } = await supabase
    .from("price_lists")
    .select(SELECT)
    .eq("id", listId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return { success: false, error: fetchError.message, status: 500 }
  }
  if (!current) {
    return { success: false, error: "Lista no encontrada.", status: 404 }
  }

  const updateRow = { name: input.name }
  const next = { ...current, ...updateRow }
  const applied = await auditedUpdate(supabase, {
    kind: "price-lists.patch",
    table: "price_lists",
    id: listId,
    row: updateRow,
    ctx: audit,
    popId,
    previous: current,
    next,
  })
  if (!applied.success) {
    const mapped = uniqueNameError(applied.error)
    return {
      success: false,
      error: mapped.error,
      status: applied.status === 404 ? 404 : mapped.status,
    }
  }
  return { success: true, data: mapRow(next as PriceListDbRow) }
}

export async function deletePriceList(
  supabase: SupabaseClient,
  popId: string,
  listId: string,
  audit: MutationAuditCtx,
): Promise<{ success: true } | { success: false; error: string; status: 404 | 409 | 500 }> {
  const { data: row, error: getError } = await supabase
    .from("price_lists")
    .select("id, is_default, name, sort_order")
    .eq("id", listId)
    .eq("pop_id", popId)
    .maybeSingle()

  if (getError) return { success: false, error: getError.message, status: 500 }
  if (!row) return { success: false, error: "Lista no encontrada.", status: 404 }
  if (row.is_default) {
    return {
      success: false,
      error: "La lista principal no se puede eliminar.",
      status: 409,
    }
  }

  const applied = await auditedDelete(supabase, {
    kind: "price-lists.delete",
    table: "price_lists",
    id: listId,
    ctx: audit,
    popId,
    previous: row,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status === 404 ? 404 : 500,
    }
  }
  return { success: true }
}
