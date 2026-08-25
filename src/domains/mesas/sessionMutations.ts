import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { auditedInsert, auditedUpdate } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import {
  checkoutHasUnpaidItems,
  syncComandasFromTableCheckout,
} from "./comandasSync.js"
import { isRecord, isUuid, mapSession, normalizeTableIds, type MutateFail } from "./map.js"
import { getOpenSession, loadSessionRow } from "./queries.js"
import {
  SESSION_SELECT,
  type FloorStatus,
  type MesaSession,
  type SessionBody,
} from "./schema.js"

type OkSession = { success: true; session: MesaSession }
type Ok = { success: true }
type OkFloor = {
  success: true
  floorStatus: FloorStatus
  updatedAt: string
}
type OkCheckout = { success: true; updatedAt: string }

function friendlyTableSessionError(message: string): string {
  if (/ya tiene una sesión abierta/i.test(message)) {
    return "Una de las mesas ya está abierta con otra cuenta. Liberála o sentá sin juntarla."
  }
  if (/inválida o inactiva/i.test(message)) {
    return "Una de las mesas no está disponible."
  }
  return message
}

async function occupiedTablesOpenError(
  supabase: SupabaseClient,
  popId: string,
  tableIds: string[],
  excludeSessionId?: string,
): Promise<string | null> {
  const { data: sessions, error } = await supabase
    .from("table_sessions")
    .select("id, dining_table_id, table_session_tables ( dining_table_id )")
    .eq("pop_id", popId)
    .eq("status", "open")
  if (error) return null

  const occupied = new Set<string>()
  for (const session of sessions ?? []) {
    if (excludeSessionId && session.id === excludeSessionId) continue
    if (typeof session.dining_table_id === "string") {
      occupied.add(session.dining_table_id)
    }
    for (const extra of session.table_session_tables ?? []) {
      if (typeof extra.dining_table_id === "string") {
        occupied.add(extra.dining_table_id)
      }
    }
  }

  const hit = tableIds.filter((id) => occupied.has(id))
  if (hit.length === 0) return null

  const { data: rows } = await supabase
    .from("dining_tables")
    .select("id, label")
    .in("id", hit)
  const labels = (rows ?? [])
    .map((row) => row.label)
    .filter(
      (label): label is string =>
        typeof label === "string" && label.trim().length > 0,
    )
  if (labels.length === 1) {
    return `La mesa ${labels[0]} ya está abierta. Liberála o sentá sin juntarla.`
  }
  if (labels.length > 1) {
    return `Las mesas ${labels.join(", ")} ya están abiertas. Liberálas o sentá sin juntarlas.`
  }
  return "Una de las mesas ya está abierta. Liberála o sentá sin juntarla."
}

async function markReservationSeated(
  supabase: SupabaseClient,
  popId: string,
  reservationId: string,
) {
  if (!reservationId) return
  await supabase
    .from("table_reservations")
    .update({ status: "seated" })
    .eq("id", reservationId)
    .eq("pop_id", popId)
    .in("status", ["pending", "confirmed"])
}

async function completeReservationsAfterClose(
  supabase: SupabaseClient,
  popId: string,
  session: {
    dining_table_id?: string | null
    metadata?: unknown
    table_session_tables?: { dining_table_id: string }[] | null
  },
) {
  const metadata = isRecord(session.metadata) ? session.metadata : null
  const linkedId =
    typeof metadata?.reservation_id === "string" && isUuid(metadata.reservation_id)
      ? metadata.reservation_id
      : null
  if (linkedId) {
    await supabase
      .from("table_reservations")
      .update({ status: "completed" })
      .eq("id", linkedId)
      .eq("pop_id", popId)
      .eq("status", "seated")
    return
  }
  const tableIds = [
    session.dining_table_id,
    ...(session.table_session_tables ?? []).map((row) => row.dining_table_id),
  ].filter((id): id is string => typeof id === "string" && isUuid(id))
  if (tableIds.length === 0) return
  await supabase
    .from("table_reservations")
    .update({ status: "completed" })
    .eq("pop_id", popId)
    .in("dining_table_id", tableIds)
    .eq("status", "seated")
}

function parseSessionInput(input: SessionBody): {
  tableIds: string[]
  waiterId: string
  guestCount: number | null
  note: string
  reservationId: string
} | { error: string } {
  const tableIds = normalizeTableIds(input.tableIds[0] ?? "", input.tableIds.slice(1))
  if (tableIds.length === 0) return { error: "Seleccioná al menos una mesa." }
  const waiterId = input.waiterId?.trim() ?? ""
  if (waiterId && !isUuid(waiterId)) return { error: "Mozo inválido." }
  const guestCount =
    input.guestCount != null && Number.isFinite(input.guestCount)
      ? Math.max(1, Math.min(50, Math.round(input.guestCount)))
      : null
  const reservationId = input.reservationId?.trim() ?? ""
  if (reservationId && !isUuid(reservationId)) return { error: "Reserva inválida." }
  return {
    tableIds,
    waiterId,
    guestCount,
    note: input.note?.trim() ?? "",
    reservationId,
  }
}

export async function openSession(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: SessionBody,
  audit: MutationAuditCtx,
): Promise<OkSession | MutateFail> {
  const parsed = parseSessionInput(input)
  if ("error" in parsed) {
    return { success: false, error: parsed.error, status: 400 }
  }
  const occupiedError = await occupiedTablesOpenError(
    supabase,
    popId,
    parsed.tableIds,
  )
  if (occupiedError) {
    return { success: false, error: occupiedError, status: 400 }
  }

  const id = randomUUID()
  const primaryTableId = parsed.tableIds[0]
  const mergedTableIds = parsed.tableIds.slice(1)
  const row: Record<string, unknown> = {
    id,
    pop_id: popId,
    dining_table_id: primaryTableId,
    status: "open",
    guest_count: parsed.guestCount,
    notes: parsed.note,
    waiter_user_id: parsed.waiterId || null,
    opened_by: userId,
  }
  if (parsed.reservationId) {
    row.metadata = { reservation_id: parsed.reservationId }
  }

  const applied = await auditedInsert(supabase, {
    kind: "mesas.session.create",
    table: "table_sessions",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return {
      success: false,
      error: friendlyTableSessionError(applied.error),
      status: applied.status,
    }
  }

  if (mergedTableIds.length > 0) {
    const { error: mergeErr } = await supabase.from("table_session_tables").insert(
      mergedTableIds.map((diningTableId) => ({
        table_session_id: id,
        dining_table_id: diningTableId,
      })),
    )
    if (mergeErr) {
      await auditedUpdate(supabase, {
        kind: "mesas.session.create.rollback",
        table: "table_sessions",
        id,
        row: { status: "cancelled", closed_at: new Date().toISOString(), closed_by: userId },
        ctx: audit,
        popId,
      })
      return {
        success: false,
        error: friendlyTableSessionError(mergeErr.message),
        status: 400,
      }
    }
  }

  await markReservationSeated(supabase, popId, parsed.reservationId)
  const loaded = await getOpenSession(supabase, popId, id)
  if (!loaded.success || !loaded.session) {
    return {
      success: false,
      error: "No se pudo leer la sesión creada.",
      status: 500,
    }
  }
  return { success: true, session: loaded.session }
}

export async function updateSession(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
  input: SessionBody,
  audit: MutationAuditCtx,
): Promise<OkSession | MutateFail> {
  const parsed = parseSessionInput(input)
  if ("error" in parsed) {
    return { success: false, error: parsed.error, status: 400 }
  }

  const { data: existing, error: existingErr } = await loadSessionRow(
    supabase,
    popId,
    sessionId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing || existing.status === "closed" || existing.status === "cancelled") {
    return {
      success: false,
      error: "La sesión no está abierta o no existe.",
      status: 404,
    }
  }
  if (existing.status !== "open") {
    return {
      success: false,
      error: "La sesión no está abierta o no existe.",
      status: 404,
    }
  }

  const occupiedError = await occupiedTablesOpenError(
    supabase,
    popId,
    parsed.tableIds,
    sessionId,
  )
  if (occupiedError) {
    return { success: false, error: occupiedError, status: 400 }
  }

  const patch = {
    dining_table_id: parsed.tableIds[0],
    guest_count: parsed.guestCount,
    notes: parsed.note,
    waiter_user_id: parsed.waiterId || null,
  }
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.session.patch",
    table: "table_sessions",
    id: sessionId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return {
      success: false,
      error: friendlyTableSessionError(applied.error),
      status: applied.status,
    }
  }

  const { error: deleteMergeErr } = await supabase
    .from("table_session_tables")
    .delete()
    .eq("table_session_id", sessionId)
  if (deleteMergeErr) {
    return { success: false, error: deleteMergeErr.message, status: 500 }
  }

  const mergedTableIds = parsed.tableIds.slice(1)
  if (mergedTableIds.length > 0) {
    const { error: mergeErr } = await supabase.from("table_session_tables").insert(
      mergedTableIds.map((diningTableId) => ({
        table_session_id: sessionId,
        dining_table_id: diningTableId,
      })),
    )
    if (mergeErr) {
      return {
        success: false,
        error: friendlyTableSessionError(mergeErr.message),
        status: 400,
      }
    }
  }

  const loaded = await getOpenSession(supabase, popId, sessionId)
  if (!loaded.success || !loaded.session) {
    return {
      success: false,
      error: "No se pudo leer la sesión actualizada.",
      status: 500,
    }
  }
  return { success: true, session: loaded.session }
}

export async function closeSession(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
  userId: string,
  reason: "cancelled" | "closed",
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const { data: existing, error: existingErr } = await supabase
    .from("table_sessions")
    .select("id, dining_table_id, status, metadata, table_session_tables ( dining_table_id )")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return {
      success: false,
      error: "La sesión no está abierta o no existe.",
      status: 404,
    }
  }

  const now = new Date().toISOString()
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.session.close",
    table: "table_sessions",
    id: sessionId,
    row: { status: reason, closed_at: now, closed_by: userId },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, status: reason, closed_at: now, closed_by: userId },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  try {
    await completeReservationsAfterClose(supabase, popId, existing)
  } catch {
    // La mesa ya se liberó; no frenar el cierre por la reserva.
  }
  return { success: true }
}

export async function closeSessionCheckout(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
  userId: string,
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const { data: session, error } = await supabase
    .from("table_sessions")
    .select("id, metadata, status")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()
  if (error) return { success: false, error: error.message, status: 500 }
  if (!session) {
    return {
      success: false,
      error: "La sesión no está abierta o no existe.",
      status: 404,
    }
  }
  const checkout =
    isRecord(session.metadata) && isRecord(session.metadata.checkout)
      ? session.metadata.checkout
      : {}
  if (checkoutHasUnpaidItems(checkout)) {
    return {
      success: false,
      error: "Hay ítems sin cobrar. Cobrá el pedido antes de liberar la mesa.",
      status: 400,
    }
  }
  return closeSession(supabase, popId, sessionId, userId, "closed", audit)
}

export async function saveSessionCheckout(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
  checkout: Record<string, unknown>,
  audit: MutationAuditCtx,
): Promise<OkCheckout | MutateFail> {
  const { data: existing, error: existingErr } = await supabase
    .from("table_sessions")
    .select("id, metadata, updated_at")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return {
      success: false,
      error: "La sesión no está abierta o no existe.",
      status: 404,
    }
  }
  const metadata = isRecord(existing.metadata)
    ? { ...existing.metadata }
    : {}
  metadata.checkout = checkout
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.session.checkout",
    table: "table_sessions",
    id: sessionId,
    row: { metadata },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, metadata },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  await syncComandasFromTableCheckout(supabase, popId, sessionId, checkout)
  const { data } = await supabase
    .from("table_sessions")
    .select("updated_at")
    .eq("id", sessionId)
    .single()
  return {
    success: true,
    updatedAt: (data?.updated_at as string) ?? new Date().toISOString(),
  }
}

export async function setSessionFloorStatus(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
  floorStatus: FloorStatus,
  audit: MutationAuditCtx,
): Promise<OkFloor | MutateFail> {
  const { data: existing, error: existingErr } = await supabase
    .from("table_sessions")
    .select("id, metadata")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return {
      success: false,
      error: "La sesión no está abierta o no existe.",
      status: 404,
    }
  }
  const metadata = isRecord(existing.metadata)
    ? { ...existing.metadata }
    : {}
  if (floorStatus === "paying") metadata.floor_status = "paying"
  else delete metadata.floor_status

  const applied = await auditedUpdate(supabase, {
    kind: "mesas.session.floor-status",
    table: "table_sessions",
    id: sessionId,
    row: { metadata },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, metadata },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data } = await supabase
    .from("table_sessions")
    .select("updated_at")
    .eq("id", sessionId)
    .single()
  return {
    success: true,
    floorStatus,
    updatedAt: (data?.updated_at as string) ?? new Date().toISOString(),
  }
}

