import type { SupabaseClient } from "@supabase/supabase-js"
import {
  mapMesasDecorRow,
  mapMesasTableRow,
  MESAS_DECOR_SELECT,
  MESAS_TABLE_SELECT,
  type MesasFloorDecorRow,
  type MesasLayoutData,
  type MesasSalonRow,
  type MesasTableRow,
} from "./mapLayout.js"

export async function loadMesasLayout(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: MesasLayoutData }
  | { success: false; error: string }
> {
  const [salonsRes, tablesRes, decorsRes] = await Promise.all([
    supabase
      .from("dining_salons")
      .select("id, name, sort_order, is_active")
      .eq("pop_id", popId)
      .is("deleted_at", null)
      .order("sort_order")
      .order("name"),
    supabase
      .from("dining_tables")
      .select(MESAS_TABLE_SELECT)
      .eq("pop_id", popId)
      .is("deleted_at", null)
      .order("sort_order")
      .order("label"),
    supabase
      .from("dining_floor_decors")
      .select(MESAS_DECOR_SELECT)
      .eq("pop_id", popId)
      .is("deleted_at", null)
      .order("sort_order"),
  ])

  if (salonsRes.error) {
    return { success: false, error: salonsRes.error.message }
  }
  if (tablesRes.error) {
    return { success: false, error: tablesRes.error.message }
  }
  if (decorsRes.error) {
    return { success: false, error: decorsRes.error.message }
  }

  const salons: MesasSalonRow[] = (salonsRes.data || []).map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order ?? 0,
    isActive: Boolean(row.is_active),
  }))

  const tables: MesasTableRow[] = (tablesRes.data || [])
    .filter((row) => row.salon_id)
    .map((row) => mapMesasTableRow(row))

  const decors: MesasFloorDecorRow[] = (decorsRes.data || [])
    .map((row) => mapMesasDecorRow(row))
    .filter((row): row is MesasFloorDecorRow => row != null)

  return { success: true, data: { salons, tables, decors } }
}
