import type { SupabaseClient } from "@supabase/supabase-js"
import { mapComandaRow, type ComandaDbRow } from "./map.js"
import {
  COMANDA_SELECT,
  DELIVERED_RETENTION_HOURS,
  type ComandaSourceKind,
  type ComandaStation,
  type ComandaTicket,
  type PendingComandaItem,
} from "./schema.js"

export async function listActiveStations(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; stations: ComandaStation[] }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("comanda_stations")
    .select("id, name, sort_order, is_active")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (error) return { success: false, error: error.message }

  let rows = data ?? []
  if (rows.length === 0) {
    const { error: seedErr } = await supabase.rpc("seed_pop_comanda_stations", {
      p_pop_id: popId,
    })
    if (!seedErr) {
      const seeded = await supabase
        .from("comanda_stations")
        .select("id, name, sort_order, is_active")
        .eq("pop_id", popId)
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true })
      if (!seeded.error) rows = seeded.data ?? []
    }
  }

  return {
    success: true,
    stations: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      sortOrder: Number(row.sort_order ?? 0) || 0,
      isActive: Boolean(row.is_active),
    })),
  }
}

export async function listStationTickets(
  supabase: SupabaseClient,
  popId: string,
  stationId: string,
): Promise<
  | { success: true; tickets: ComandaTicket[] }
  | { success: false; error: string }
> {
  const since = new Date(
    Date.now() - DELIVERED_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString()

  const [openRes, deliveredRes] = await Promise.all([
    supabase
      .from("comandas")
      .select(COMANDA_SELECT)
      .eq("pop_id", popId)
      .eq("station_id", stationId)
      .in("status", ["sent", "preparing", "ready"])
      .order("created_at", { ascending: true }),
    supabase
      .from("comandas")
      .select(COMANDA_SELECT)
      .eq("pop_id", popId)
      .eq("station_id", stationId)
      .eq("status", "delivered")
      .gte("delivered_at", since)
      .order("created_at", { ascending: true }),
  ])

  if (openRes.error) return { success: false, error: openRes.error.message }
  if (deliveredRes.error) {
    return { success: false, error: deliveredRes.error.message }
  }

  return {
    success: true,
    tickets: [...(openRes.data ?? []), ...(deliveredRes.data ?? [])].map((row) =>
      mapComandaRow(row as ComandaDbRow),
    ),
  }
}

export async function listTicketsByCartLineIds(
  supabase: SupabaseClient,
  popId: string,
  cartLineIds: string[],
): Promise<ComandaTicket[]> {
  const ids = [...new Set(cartLineIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from("comandas")
    .select(COMANDA_SELECT)
    .eq("pop_id", popId)
    .in("cart_line_id", ids)
  if (error || !data) return []
  return data.map((row) => mapComandaRow(row as ComandaDbRow))
}

export async function getComandaTicket(
  supabase: SupabaseClient,
  popId: string,
  ticketId: string,
): Promise<
  | { success: true; ticket: ComandaTicket | null }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("comandas")
    .select(COMANDA_SELECT)
    .eq("id", ticketId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: true, ticket: null }
  return { success: true, ticket: mapComandaRow(data as ComandaDbRow) }
}

export async function listPendingForSource(
  supabase: SupabaseClient,
  popId: string,
  sourceKind: ComandaSourceKind,
  sourceId: string,
): Promise<
  | { success: true; items: PendingComandaItem[] }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("comandas")
    .select(
      `
      id,
      cart_line_id,
      recipe_name,
      quantity,
      comment,
      station_id,
      comanda_stations ( name )
    `,
    )
    .eq("pop_id", popId)
    .eq("source_kind", sourceKind)
    .eq("source_id", sourceId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    items: (data ?? []).map((row) => {
      const rel = row.comanda_stations as
        | { name?: string | null }
        | { name?: string | null }[]
        | null
      const station = Array.isArray(rel) ? rel[0] : rel
      return {
        id: String(row.id),
        cartLineId: String(row.cart_line_id),
        recipeName: String(row.recipe_name ?? ""),
        quantity: Math.max(1, Number(row.quantity) || 1),
        comment: String(row.comment ?? ""),
        stationId: String(row.station_id),
        stationName: station?.name?.trim() || "Estación",
      }
    }),
  }
}
