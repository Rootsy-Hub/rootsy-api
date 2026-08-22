import type { SupabaseClient } from "@supabase/supabase-js"
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

function uniqueNameError(error: { code?: string; message?: string } | null) {
  if (error?.code === "23505") {
    return "Ya existe una lista con ese nombre."
  }
  return error?.message || "No se pudo guardar."
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

  const { data, error } = await supabase
    .from("price_lists")
    .insert({
      pop_id: popId,
      name: input.name,
      is_default: false,
      sort_order: sortOrder,
    })
    .select(SELECT)
    .single()

  if (error || !data) {
    return {
      success: false,
      error: uniqueNameError(error),
      status: error?.code === "23505" ? 409 : 500,
    }
  }
  return { success: true, data: mapRow(data as PriceListDbRow) }
}

export async function updatePriceList(
  supabase: SupabaseClient,
  popId: string,
  listId: string,
  input: { name: string },
): Promise<
  | { success: true; data: PriceListRow }
  | { success: false; error: string; status: 404 | 409 | 500 }
> {
  const { data, error } = await supabase
    .from("price_lists")
    .update({ name: input.name })
    .eq("id", listId)
    .eq("pop_id", popId)
    .select(SELECT)
    .maybeSingle()

  if (error) {
    return {
      success: false,
      error: uniqueNameError(error),
      status: error.code === "23505" ? 409 : 500,
    }
  }
  if (!data) return { success: false, error: "Lista no encontrada.", status: 404 }
  return { success: true, data: mapRow(data as PriceListDbRow) }
}

export async function deletePriceList(
  supabase: SupabaseClient,
  popId: string,
  listId: string,
): Promise<{ success: true } | { success: false; error: string; status: 404 | 409 | 500 }> {
  const { data: row, error: getError } = await supabase
    .from("price_lists")
    .select("id, is_default")
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

  const { error } = await supabase
    .from("price_lists")
    .delete()
    .eq("id", listId)
    .eq("pop_id", popId)

  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}
