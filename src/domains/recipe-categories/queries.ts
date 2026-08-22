import type { SupabaseClient } from "@supabase/supabase-js"
import type { RecipeCategoryDetail, RecipeCategoryRow } from "./schema.js"

const SELECT =
  "id, pop_id, name, sort_order, show_in_menu, is_active, station_id, created_at, updated_at, comanda_stations ( name )"

type RecipeCategoryDbRow = {
  id: string
  pop_id: string
  name: string
  sort_order: number
  show_in_menu: boolean
  is_active: boolean
  station_id: string | null
  created_at: string
  updated_at: string
  comanda_stations?: { name?: string } | { name?: string }[] | null
}

function stationNameFromRow(row: RecipeCategoryDbRow): string | null {
  const stationRel = row.comanda_stations
  const station = Array.isArray(stationRel) ? stationRel[0] : stationRel
  const name = station?.name?.trim()
  return name ? name : null
}

function mapRow(row: RecipeCategoryDbRow): RecipeCategoryRow {
  return {
    id: row.id,
    popId: row.pop_id,
    name: row.name,
    sortOrder: row.sort_order ?? 0,
    showInMenu: Boolean(row.show_in_menu),
    isActive: Boolean(row.is_active),
    stationId: row.station_id,
    stationName: stationNameFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function nextSortOrder(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data: maxRow } = await supabase
    .from("recipe_categories")
    .select("sort_order")
    .eq("pop_id", popId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()
  return maxRow?.sort_order != null ? Number(maxRow.sort_order) + 1 : 0
}

async function assertStationInPop(
  supabase: SupabaseClient,
  popId: string,
  stationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("comanda_stations")
    .select("id")
    .eq("id", stationId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Esa estación no existe." }
  return { ok: true }
}

export async function listRecipeCategories(
  supabase: SupabaseClient,
  popId: string,
  filters: {
    showInMenu?: boolean
    isActive?: boolean
  },
): Promise<
  { success: true; data: RecipeCategoryRow[] } | { success: false; error: string }
> {
  let q = supabase
    .from("recipe_categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .order("sort_order")
    .order("name")

  if (filters.showInMenu != null) q = q.eq("show_in_menu", filters.showInMenu)
  if (filters.isActive != null) q = q.eq("is_active", filters.isActive)

  const { data, error } = await q
  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: (data ?? []).map((row) => mapRow(row as RecipeCategoryDbRow)),
  }
}

export async function getRecipeCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<
  | { success: true; data: RecipeCategoryDetail }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("recipe_categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("id", categoryId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }

  const { count, error: countError } = await supabase
    .from("recipes")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("category_id", categoryId)
  if (countError) return { success: false, error: countError.message, status: 500 }

  return {
    success: true,
    data: {
      ...mapRow(data as RecipeCategoryDbRow),
      recipeCount: count ?? 0,
    },
  }
}

export async function createRecipeCategory(
  supabase: SupabaseClient,
  popId: string,
  input: {
    name: string
    stationId?: string | null
    showInMenu?: boolean
    isActive?: boolean
    sortOrder?: number
  },
): Promise<
  | { success: true; data: RecipeCategoryRow }
  | { success: false; error: string; status?: 400 }
> {
  if (input.stationId) {
    const station = await assertStationInPop(supabase, popId, input.stationId)
    if (!station.ok) {
      return { success: false, error: station.error, status: 400 }
    }
  }

  const sortOrder = input.sortOrder ?? (await nextSortOrder(supabase, popId))

  const { data, error } = await supabase
    .from("recipe_categories")
    .insert({
      pop_id: popId,
      name: input.name,
      station_id: input.stationId ?? null,
      sort_order: sortOrder,
      show_in_menu: input.showInMenu ?? true,
      is_active: input.isActive ?? true,
    })
    .select(SELECT)
    .single()

  if (error || !data) {
    return { success: false, error: error?.message || "No se pudo crear." }
  }
  return { success: true, data: mapRow(data as RecipeCategoryDbRow) }
}

export async function updateRecipeCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
  input: {
    name?: string
    stationId?: string | null
    showInMenu?: boolean
    isActive?: boolean
    sortOrder?: number
  },
): Promise<
  | { success: true; data: RecipeCategoryRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  if (input.stationId) {
    const station = await assertStationInPop(supabase, popId, input.stationId)
    if (!station.ok) {
      return { success: false, error: station.error, status: 404 }
    }
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (input.name != null) patch.name = input.name
  if (input.stationId !== undefined) patch.station_id = input.stationId
  if (input.showInMenu != null) patch.show_in_menu = input.showInMenu
  if (input.isActive != null) patch.is_active = input.isActive
  if (input.sortOrder != null) patch.sort_order = input.sortOrder

  const { data, error } = await supabase
    .from("recipe_categories")
    .update(patch)
    .eq("id", categoryId)
    .eq("pop_id", popId)
    .select(SELECT)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }
  return { success: true, data: mapRow(data as RecipeCategoryDbRow) }
}

export async function deleteRecipeCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<
  { success: true } | { success: false; error: string; status: 404 | 409 | 500 }
> {
  const existing = await getRecipeCategory(supabase, popId, categoryId)
  if (!existing.success) return existing

  const { count, error: countError } = await supabase
    .from("recipes")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("category_id", categoryId)

  if (countError) {
    return { success: false, error: countError.message, status: 500 }
  }
  if ((count ?? 0) > 0) {
    return {
      success: false,
      status: 409,
      error: `No se puede eliminar "${existing.data.name}": tiene ${count} receta(s).`,
    }
  }

  const { error } = await supabase
    .from("recipe_categories")
    .delete()
    .eq("id", categoryId)
    .eq("pop_id", popId)

  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}

export async function layoutRecipeCategories(
  supabase: SupabaseClient,
  popId: string,
  updates: { id: string; sortOrder: number; showInMenu: boolean }[],
): Promise<{ success: true } | { success: false; error: string; status: 400 | 500 }> {
  const ids = [...new Set(updates.map((u) => u.id))]
  const { data: validRows, error: validErr } = await supabase
    .from("recipe_categories")
    .select("id")
    .eq("pop_id", popId)
    .in("id", ids)

  if (validErr) return { success: false, error: validErr.message, status: 500 }

  const validIds = new Set((validRows ?? []).map((row) => String(row.id)))
  const filtered = updates.filter((u) => validIds.has(u.id))
  if (filtered.length === 0) {
    return { success: false, error: "Ninguna categoría es válida.", status: 400 }
  }

  for (const u of filtered) {
    const { error } = await supabase
      .from("recipe_categories")
      .update({
        sort_order: u.sortOrder,
        show_in_menu: u.showInMenu,
        updated_at: new Date().toISOString(),
      })
      .eq("id", u.id)
      .eq("pop_id", popId)
    if (error) return { success: false, error: error.message, status: 500 }
  }

  return { success: true }
}
