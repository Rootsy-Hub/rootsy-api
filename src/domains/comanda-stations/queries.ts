import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  auditedDelete,
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import type { ComandaStationDetail, ComandaStationRow } from "./schema.js"

const SELECT = "id, name, sort_order, is_active"

type StationDbRow = {
  id: string
  name: string
  sort_order: number
  is_active: boolean
}

function mapRow(row: StationDbRow): ComandaStationRow {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    sortOrder: Number(row.sort_order ?? 0) || 0,
    isActive: Boolean(row.is_active),
  }
}

function stationUniqueNameError(message: string): string {
  if (/comanda_stations_pop_name_unique|duplicate key/i.test(message)) {
    return "Ya existe una estación con ese nombre."
  }
  return message
}

async function nextSortOrder(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data: maxRow } = await supabase
    .from("comanda_stations")
    .select("sort_order")
    .eq("pop_id", popId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (Number(maxRow?.sort_order ?? -1) || -1) + 1
}

export async function listComandaStations(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: ComandaStationRow[] }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("comanda_stations")
    .select(SELECT)
    .eq("pop_id", popId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (error) return { success: false, error: error.message }

  let rows = data ?? []
  if (rows.length === 0) {
    const { error: seedErr } = await supabase.rpc("seed_pop_comanda_stations", {
      p_pop_id: popId,
    })
    if (seedErr) return { success: false, error: seedErr.message }
    const seeded = await supabase
      .from("comanda_stations")
      .select(SELECT)
      .eq("pop_id", popId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
    if (seeded.error) return { success: false, error: seeded.error.message }
    rows = seeded.data ?? []
  }

  return {
    success: true,
    data: rows.map((row) => mapRow(row as StationDbRow)),
  }
}

export async function getComandaStation(
  supabase: SupabaseClient,
  popId: string,
  stationId: string,
): Promise<
  | { success: true; data: ComandaStationDetail }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("comanda_stations")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("id", stationId)
    .maybeSingle()
  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Estación no encontrada.", status: 404 }
  }

  const { count, error: countError } = await supabase
    .from("recipe_categories")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("station_id", stationId)
  if (countError) {
    return { success: false, error: countError.message, status: 500 }
  }

  return {
    success: true,
    data: {
      ...mapRow(data as StationDbRow),
      categoryCount: count ?? 0,
    },
  }
}

export async function createComandaStation(
  supabase: SupabaseClient,
  popId: string,
  name: string,
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: ComandaStationRow }
  | { success: false; error: string; status?: 400 }
> {
  const sortOrder = await nextSortOrder(supabase, popId)
  const id = randomUUID()
  const row: StationDbRow = {
    id,
    name,
    sort_order: sortOrder,
    is_active: true,
  }
  const applied = await auditedInsert(supabase, {
    kind: "comanda-stations.create",
    table: "comanda_stations",
    row: { ...row, pop_id: popId },
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return {
      success: false,
      error: stationUniqueNameError(applied.error || "No se pudo crear la estación."),
      status: 400,
    }
  }
  return { success: true, data: mapRow(row) }
}

export async function updateComandaStation(
  supabase: SupabaseClient,
  popId: string,
  stationId: string,
  name: string,
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: ComandaStationRow }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const { data: current, error: fetchError } = await supabase
    .from("comanda_stations")
    .select(SELECT)
    .eq("id", stationId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return { success: false, error: fetchError.message, status: 500 }
  }
  if (!current) {
    return { success: false, error: "Estación no encontrada.", status: 404 }
  }
  const next = { ...current, name }
  const applied = await auditedUpdate(supabase, {
    kind: "comanda-stations.patch",
    table: "comanda_stations",
    id: stationId,
    row: { name },
    ctx: audit,
    popId,
    previous: current,
    next,
  })
  if (!applied.success) {
    const unique = /comanda_stations_pop_name_unique|duplicate key/i.test(
      applied.error,
    )
    return {
      success: false,
      error: stationUniqueNameError(applied.error),
      status: unique ? 400 : applied.status === 404 ? 404 : 500,
    }
  }
  return { success: true, data: mapRow(next as StationDbRow) }
}

export async function deleteComandaStation(
  supabase: SupabaseClient,
  popId: string,
  stationId: string,
  audit: MutationAuditCtx,
): Promise<
  { success: true } | { success: false; error: string; status: 404 | 409 | 500 }
> {
  const existing = await getComandaStation(supabase, popId, stationId)
  if (!existing.success) return existing
  if (existing.data.categoryCount > 0) {
    return {
      success: false,
      status: 409,
      error: "No podés eliminar una estación asignada a categorías.",
    }
  }

  const applied = await auditedDelete(supabase, {
    kind: "comanda-stations.delete",
    table: "comanda_stations",
    id: stationId,
    ctx: audit,
    popId,
    previous: existing.data,
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
