import type { SupabaseClient } from "@supabase/supabase-js"
import { operationalDayCloseTimeFromSettings } from "../settings/parse.js"
import { mapDecor, mapReservation, mapSalon, mapSession, mapTable } from "./map.js"
import {
  DECOR_SELECT,
  RESERVATION_SELECT,
  SESSION_SELECT,
  TABLE_SELECT,
  type MesaReservation,
  type MesaSession,
  type MesasDecor,
  type MesasSalon,
  type MesasTable,
  type MesasWaiter,
} from "./schema.js"

function isMozoRole(roleName: string, roleDisplayName: string): boolean {
  const name = roleName.trim().toLowerCase()
  const display = roleDisplayName.trim().toLowerCase()
  return (
    name === "mozo" ||
    name === "mozos" ||
    display === "mozo" ||
    display === "mozos"
  )
}

export async function getMesasLayout(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: { salons: MesasSalon[]; tables: MesasTable[]; decors: MesasDecor[] } }
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
      .select(TABLE_SELECT)
      .eq("pop_id", popId)
      .is("deleted_at", null)
      .order("sort_order")
      .order("label"),
    supabase
      .from("dining_floor_decors")
      .select(DECOR_SELECT)
      .eq("pop_id", popId)
      .is("deleted_at", null)
      .order("sort_order"),
  ])

  if (salonsRes.error) return { success: false, error: salonsRes.error.message }
  if (tablesRes.error) return { success: false, error: tablesRes.error.message }
  if (decorsRes.error) return { success: false, error: decorsRes.error.message }

  return {
    success: true,
    data: {
      salons: (salonsRes.data || []).map(mapSalon),
      tables: (tablesRes.data || [])
        .filter((row) => row.salon_id)
        .map(mapTable),
      decors: (decorsRes.data || [])
        .map(mapDecor)
        .filter((row): row is MesasDecor => row != null),
    },
  }
}

export async function getMesasWaiters(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; waiters: MesasWaiter[] }
  | { success: false; error: string }
> {
  const { data: uprRows, error: uprErr } = await supabase
    .from("user_pop_roles")
    .select(
      `
      user_id,
      roles:role_id ( name, display_name )
    `,
    )
    .eq("pop_id", popId)
    .eq("is_active", true)

  if (uprErr) return { success: false, error: uprErr.message }

  const mozoUserIds = [
    ...new Set(
      (uprRows || [])
        .filter((row) => {
          const rel = row.roles as unknown as {
            name: string
            display_name: string
          } | null
          if (!rel) return false
          return isMozoRole(rel.name, rel.display_name)
        })
        .map((row) => row.user_id),
    ),
  ]

  if (mozoUserIds.length === 0) return { success: true, waiters: [] }

  const { data: profiles, error: profilesErr } = await supabase
    .from("users")
    .select("id, first_name, last_name")
    .in("id", mozoUserIds)

  if (profilesErr) return { success: false, error: profilesErr.message }

  const waiters = (profiles || [])
    .map((p) => {
      const firstName = p.first_name ?? ""
      const lastName = p.last_name ?? ""
      const full = `${firstName} ${lastName}`.trim() || "Sin nombre"
      const initials =
        `${firstName.trim().charAt(0)}${lastName.trim().charAt(0)}`.toUpperCase() ||
        "?"
      return { id: p.id as string, name: full, initials }
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"))

  return { success: true, waiters }
}

export async function listOpenSessions(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; sessions: MesaSession[] }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("table_sessions")
    .select(SESSION_SELECT)
    .eq("pop_id", popId)
    .eq("status", "open")
    .order("opened_at")

  if (error) return { success: false, error: error.message }
  return {
    success: true,
    sessions: (data ?? []).map((row) =>
      mapSession(row as unknown as Parameters<typeof mapSession>[0]),
    ),
  }
}

export async function getOpenSession(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<
  | { success: true; session: MesaSession | null }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("table_sessions")
    .select(SESSION_SELECT)
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!data) return { success: true, session: null }
  return {
    success: true,
    session: mapSession(data as unknown as Parameters<typeof mapSession>[0]),
  }
}

export async function listReservations(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; reservations: MesaReservation[] }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("table_reservations")
    .select(RESERVATION_SELECT)
    .eq("pop_id", popId)
    .order("arrival_at")

  if (error) return { success: false, error: error.message }
  return {
    success: true,
    reservations: (data ?? []).map((row) =>
      mapReservation(row as unknown as Parameters<typeof mapReservation>[0]),
    ),
  }
}

const DEFAULT_FLOOR_BUFFER = 45
const DEFAULT_GRACE = 20

export function readReservationSettings(popSettings: Record<string, unknown> | null): {
  floorBufferMinutes: number
  graceMinutes: number
} {
  const mesas =
    popSettings?.mesas &&
    typeof popSettings.mesas === "object" &&
    !Array.isArray(popSettings.mesas)
      ? (popSettings.mesas as Record<string, unknown>)
      : null
  const buffer = Number(mesas?.reservationFloorBufferMinutes)
  const grace = Number(mesas?.reservationGraceMinutes)
  return {
    floorBufferMinutes:
      Number.isFinite(buffer) && buffer >= 0
        ? Math.min(240, Math.round(buffer))
        : DEFAULT_FLOOR_BUFFER,
    graceMinutes:
      Number.isFinite(grace) && grace >= 0
        ? Math.min(120, Math.round(grace))
        : DEFAULT_GRACE,
  }
}

export async function getReservationSettings(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | {
      success: true
      settings: { floorBufferMinutes: number; graceMinutes: number }
      operationalDayCloseTime: string
    }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("pops")
    .select("settings")
    .eq("id", popId)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  const popSettings =
    data?.settings && typeof data.settings === "object"
      ? (data.settings as Record<string, unknown>)
      : null
  return {
    success: true,
    settings: readReservationSettings(popSettings),
    operationalDayCloseTime: operationalDayCloseTimeFromSettings(popSettings),
  }
}

export async function loadSessionRow(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
) {
  return supabase
    .from("table_sessions")
    .select(SESSION_SELECT)
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .maybeSingle()
}
