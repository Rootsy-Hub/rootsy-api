import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { auditedInsert, auditedUpdate } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { asSettingsObject } from "../settings/parse.js"
import { isUuid, mapReservation, normalizeTableIds, parseReservationStatus, type MutateFail } from "./map.js"
import { readReservationSettings } from "./queries.js"
import { findReservationTableConflict } from "./reservationConflict.js"
import {
  RESERVATION_SELECT,
  type MesaReservation,
  type ReservationBody,
  type ReservationStatus,
} from "./schema.js"

type OkReservation = { success: true; reservation: MesaReservation }
type Ok = { success: true }

function reservationWriteError(message: string | undefined, fallback: string): string {
  if (message?.includes("table_reservations_table_arrival_idx")) {
    return "Esa mesa ya tiene una reserva en el mismo horario."
  }
  return message || fallback
}

async function loadReservation(
  supabase: SupabaseClient,
  popId: string,
  reservationId: string,
) {
  return supabase
    .from("table_reservations")
    .select(RESERVATION_SELECT)
    .eq("id", reservationId)
    .eq("pop_id", popId)
    .maybeSingle()
}

async function syncExtraTables(
  supabase: SupabaseClient,
  reservationId: string,
  extraTableIds: string[],
): Promise<string | null> {
  const { error: deleteErr } = await supabase
    .from("table_reservation_tables")
    .delete()
    .eq("table_reservation_id", reservationId)
  if (deleteErr) return deleteErr.message
  if (extraTableIds.length === 0) return null
  const { error: insertErr } = await supabase.from("table_reservation_tables").insert(
    extraTableIds.map((diningTableId) => ({
      table_reservation_id: reservationId,
      dining_table_id: diningTableId,
    })),
  )
  return insertErr?.message ?? null
}

export async function upsertReservation(
  supabase: SupabaseClient,
  popId: string,
  input: ReservationBody,
  reservationId: string | null,
  audit: MutationAuditCtx,
): Promise<OkReservation | MutateFail> {
  const requestedTableIds = (input.tableIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean)
  const tableIdRaw = requestedTableIds[0] || input.tableId?.trim() || ""
  const tableId = tableIdRaw && isUuid(tableIdRaw) ? tableIdRaw : null
  if (tableIdRaw && !tableId) {
    return { success: false, error: "Mesa inválida.", status: 400 }
  }
  const extraTableIds = normalizeTableIds(
    tableId ?? "",
    requestedTableIds.slice(1),
  ).filter((id) => id !== tableId)
  if (extraTableIds.some((id) => !isUuid(id))) {
    return { success: false, error: "Mesa inválida.", status: 400 }
  }
  if (extraTableIds.length > 0 && !tableId) {
    return {
      success: false,
      error: "Elegí una mesa principal para unir las demás.",
      status: 400,
    }
  }

  if (tableId && extraTableIds.length > 0) {
    const { data: tableRows, error: tableRowsErr } = await supabase
      .from("dining_tables")
      .select("id, salon_id")
      .eq("pop_id", popId)
      .in("id", [tableId, ...extraTableIds])
    if (tableRowsErr) {
      return { success: false, error: tableRowsErr.message, status: 500 }
    }
    if ((tableRows ?? []).length !== extraTableIds.length + 1) {
      return {
        success: false,
        error: "Alguna mesa no pertenece a este local.",
        status: 400,
      }
    }
    const salonIds = new Set((tableRows ?? []).map((row) => row.salon_id as string))
    if (salonIds.size > 1) {
      return {
        success: false,
        error: "Las mesas unidas tienen que ser del mismo salón.",
        status: 400,
      }
    }
  }

  const clientId = input.clientId?.trim() ?? ""
  if (clientId && !isUuid(clientId)) {
    return { success: false, error: "Cliente inválido.", status: 400 }
  }
  const clientName = input.clientName?.trim() ?? ""
  if (!clientId && !clientName) {
    return {
      success: false,
      error: "Indicá un cliente para la reserva.",
      status: 400,
    }
  }
  const arrivalAt = input.arrivalAt?.trim() ?? ""
  if (!arrivalAt || Number.isNaN(Date.parse(arrivalAt))) {
    return {
      success: false,
      error: "Indicá una hora de llegada válida.",
      status: 400,
    }
  }
  const guestCount =
    input.guestCount != null && Number.isFinite(input.guestCount)
      ? Math.max(1, Math.min(50, Math.round(input.guestCount)))
      : null
  const status = input.status ? parseReservationStatus(input.status) : "confirmed"

  const assignedTableIds = tableId ? [tableId, ...extraTableIds] : []
  if (assignedTableIds.length > 0) {
    const [{ data: popRow }, { data: existingRows, error: existingRowsErr }] =
      await Promise.all([
        supabase.from("pops").select("settings").eq("id", popId).maybeSingle(),
        supabase
          .from("table_reservations")
          .select(RESERVATION_SELECT)
          .eq("pop_id", popId)
          .in("status", ["pending", "confirmed"]),
      ])
    if (existingRowsErr) {
      return { success: false, error: existingRowsErr.message, status: 500 }
    }
    const popSettings =
      popRow?.settings && typeof popRow.settings === "object"
        ? (popRow.settings as Record<string, unknown>)
        : null
    const conflict = findReservationTableConflict({
      tableIds: assignedTableIds,
      arrivalAt,
      settings: readReservationSettings(popSettings),
      reservations: (existingRows ?? []).map((row) =>
        mapReservation(row as unknown as Parameters<typeof mapReservation>[0]),
      ),
      excludeReservationId: reservationId,
    })
    if (conflict) {
      const name = conflict.clientName.trim() || "otro cliente"
      return {
        success: false,
        error: `Esa mesa ya está reservada para ${name} en un horario que se pisa.`,
        status: 400,
      }
    }
  }

  const payload = {
    pop_id: popId,
    dining_table_id: tableId,
    client_id: clientId || null,
    client_name: clientName,
    guest_count: guestCount,
    arrival_at: arrivalAt,
    status,
    notes: input.note?.trim() ?? "",
  }

  if (reservationId) {
    const { data: existing, error: existingErr } = await supabase
      .from("table_reservations")
      .select("status")
      .eq("id", reservationId)
      .eq("pop_id", popId)
      .maybeSingle()
    if (existingErr) {
      return { success: false, error: existingErr.message, status: 500 }
    }
    if (!existing) {
      return { success: false, error: "La reserva no existe.", status: 404 }
    }
    if (
      existing.status === "seated" ||
      existing.status === "completed" ||
      existing.status === "expired" ||
      existing.status === "cancelled"
    ) {
      return {
        success: false,
        error: "No se puede editar una reserva cerrada o cancelada.",
        status: 400,
      }
    }

    const applied = await auditedUpdate(supabase, {
      kind: "mesas.reservation.patch",
      table: "table_reservations",
      id: reservationId,
      row: payload,
      ctx: audit,
      popId,
      previous: existing,
      next: { ...existing, ...payload },
    })
    if (!applied.success) {
      return {
        success: false,
        error: reservationWriteError(applied.error, "No se pudo actualizar la reserva."),
        status: applied.status,
      }
    }
    const extrasErr = await syncExtraTables(supabase, reservationId, extraTableIds)
    if (extrasErr) {
      return { success: false, error: extrasErr, status: 400 }
    }
    const { data, error } = await loadReservation(supabase, popId, reservationId)
    if (error || !data) {
      return {
        success: false,
        error: error?.message || "No se pudo leer la reserva actualizada.",
        status: 500,
      }
    }
    return {
      success: true,
      reservation: mapReservation(
        data as unknown as Parameters<typeof mapReservation>[0],
      ),
    }
  }

  const id = randomUUID()
  const applied = await auditedInsert(supabase, {
    kind: "mesas.reservation.create",
    table: "table_reservations",
    row: { ...payload, id },
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return {
      success: false,
      error: reservationWriteError(applied.error, "No se pudo guardar la reserva."),
      status: applied.status,
    }
  }
  const extrasErr = await syncExtraTables(supabase, id, extraTableIds)
  if (extrasErr) {
    await auditedUpdate(supabase, {
      kind: "mesas.reservation.create.rollback",
      table: "table_reservations",
      id,
      row: { status: "cancelled" },
      ctx: audit,
      popId,
    })
    return { success: false, error: extrasErr, status: 400 }
  }
  const { data, error } = await loadReservation(supabase, popId, id)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer la reserva creada.",
      status: 500,
    }
  }
  return {
    success: true,
    reservation: mapReservation(
      data as unknown as Parameters<typeof mapReservation>[0],
    ),
  }
}

export async function cancelReservation(
  supabase: SupabaseClient,
  popId: string,
  reservationId: string,
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const { data: existing, error: existingErr } = await supabase
    .from("table_reservations")
    .select("id, status")
    .eq("id", reservationId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "La reserva no existe o ya fue cerrada.", status: 404 }
  }
  if (existing.status !== "pending" && existing.status !== "confirmed") {
    return { success: false, error: "La reserva no existe o ya fue cerrada.", status: 404 }
  }
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.reservation.cancel",
    table: "table_reservations",
    id: reservationId,
    row: { status: "cancelled" },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, status: "cancelled" },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function updateReservationStatus(
  supabase: SupabaseClient,
  popId: string,
  reservationId: string,
  status: ReservationStatus,
  audit: MutationAuditCtx,
): Promise<OkReservation | MutateFail> {
  const { data: existing, error: existingErr } = await loadReservation(
    supabase,
    popId,
    reservationId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "La reserva no existe.", status: 404 }
  }
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.reservation.status",
    table: "table_reservations",
    id: reservationId,
    row: { status },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, status },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadReservation(supabase, popId, reservationId)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo actualizar la reserva.",
      status: 500,
    }
  }
  return {
    success: true,
    reservation: mapReservation(
      data as unknown as Parameters<typeof mapReservation>[0],
    ),
  }
}

export async function updateReservationSettings(
  supabase: SupabaseClient,
  popId: string,
  input: { floorBufferMinutes: number; graceMinutes: number },
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const settings = readReservationSettings({
    mesas: {
      reservationFloorBufferMinutes: input.floorBufferMinutes,
      reservationGraceMinutes: input.graceMinutes,
    },
  })
  const { data: popRow, error: readError } = await supabase
    .from("pops")
    .select("settings")
    .eq("id", popId)
    .maybeSingle()
  if (readError) {
    return { success: false, error: readError.message, status: 500 }
  }
  if (!popRow) {
    return { success: false, error: "No se encontró el punto.", status: 404 }
  }
  const currentSettings = asSettingsObject(popRow.settings)
  const currentMesas =
    currentSettings.mesas &&
    typeof currentSettings.mesas === "object" &&
    !Array.isArray(currentSettings.mesas)
      ? { ...(currentSettings.mesas as Record<string, unknown>) }
      : {}
  const nextSettings = {
    ...currentSettings,
    mesas: {
      ...currentMesas,
      reservationFloorBufferMinutes: settings.floorBufferMinutes,
      reservationGraceMinutes: settings.graceMinutes,
    },
  }
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.reservation-settings.patch",
    table: "pops",
    id: popId,
    row: { settings: nextSettings, updated_at: new Date().toISOString() },
    ctx: audit,
    popId,
    previous: popRow,
    next: { settings: nextSettings },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
