import type { SupabaseClient } from "@supabase/supabase-js"
import { parseDockItemIds, type DockRow } from "./schema.js"

const SELECT = "pop_id, user_id, dock_item_ids, created_at, updated_at"

type DockDbRow = {
  pop_id: string
  user_id: string
  dock_item_ids: unknown
  created_at: string
  updated_at: string
}

function mapRow(row: DockDbRow): DockRow {
  return {
    popId: row.pop_id,
    userId: row.user_id,
    dockItemIds: parseDockItemIds(row.dock_item_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function getDock(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
): Promise<
  | { success: true; data: DockRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("pop_user_menu_dock_preferences")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("user_id", userId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) return { success: false, error: "Dock no encontrado", status: 404 }
  return { success: true, data: mapRow(data as DockDbRow) }
}

export async function createDock(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: { dockItemIds: DockRow["dockItemIds"] },
): Promise<
  | { success: true; data: DockRow }
  | { success: false; error: string; status: 409 | 500 }
> {
  const existing = await getDock(supabase, popId, userId)
  if (existing.success) {
    return { success: false, error: "El dock ya existe", status: 409 }
  }
  if (existing.status === 500) {
    return { success: false, error: existing.error, status: 500 }
  }

  const { data, error } = await supabase
    .from("pop_user_menu_dock_preferences")
    .insert({
      pop_id: popId,
      user_id: userId,
      dock_item_ids: input.dockItemIds,
    })
    .select(SELECT)
    .single()

  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo crear.",
      status: 500,
    }
  }
  return { success: true, data: mapRow(data as DockDbRow) }
}

export async function updateDock(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: { dockItemIds: DockRow["dockItemIds"] },
): Promise<
  | { success: true; data: DockRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("pop_user_menu_dock_preferences")
    .update({
      dock_item_ids: input.dockItemIds,
      updated_at: new Date().toISOString(),
    })
    .eq("pop_id", popId)
    .eq("user_id", userId)
    .select(SELECT)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) return { success: false, error: "Dock no encontrado", status: 404 }
  return { success: true, data: mapRow(data as DockDbRow) }
}

export async function deleteDock(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
): Promise<{ success: true } | { success: false; error: string; status: 404 | 500 }> {
  const existing = await getDock(supabase, popId, userId)
  if (!existing.success) return existing

  const { error } = await supabase
    .from("pop_user_menu_dock_preferences")
    .delete()
    .eq("pop_id", popId)
    .eq("user_id", userId)

  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}
