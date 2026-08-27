import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import type { MesaReservation, MesaSession } from "./schema.js"

export type MesasEventType =
  | "mesas.session_opened"
  | "mesas.session_updated"
  | "mesas.session_closed"
  | "mesas.checkout_saved"
  | "mesas.floor_status_changed"
  | "mesas.layout_changed"
  | "mesas.reservation_upserted"
  | "mesas.reservation_cancelled"
  | "mesas.reservation_status_changed"
  | "mesas.settings_updated"

const MESAS_REALTIME_READ = ["mesas:read"] as const
const CHECKOUT_PAYLOAD_BUDGET = 6_000

export function sessionRealtimeSnapshot(
  session: MesaSession,
): Record<string, unknown> {
  return {
    id: session.id,
    tableIds: session.tableIds,
    waiterId: session.waiterId,
    guestCount: session.guestCount,
    note: session.note,
    openedAt: session.openedAt,
    updatedAt: session.updatedAt,
    floorStatus: session.floorStatus,
  }
}

export function reservationRealtimeSnapshot(
  reservation: MesaReservation,
): Record<string, unknown> {
  return {
    id: reservation.id,
    tableId: reservation.tableId,
    tableIds: reservation.tableIds,
    clientId: reservation.clientId,
    clientName: reservation.clientName,
    guestCount: reservation.guestCount,
    arrivalAt: reservation.arrivalAt,
    status: reservation.status,
    note: reservation.note,
    updatedAt: reservation.updatedAt,
  }
}

export function checkoutSavedPayload(
  sessionId: string,
  updatedAt: string,
  checkout: Record<string, unknown>,
): Record<string, unknown> {
  const withCheckout = { sessionId, updatedAt, checkout }
  if (JSON.stringify(withCheckout).length <= CHECKOUT_PAYLOAD_BUDGET) {
    return withCheckout
  }
  return { sessionId, updatedAt }
}

export async function publishMesasEvent(
  c: Context<SidecarEnv>,
  input: {
    type: MesasEventType
    resourceId: string
    resourceType?: string
    payload?: Record<string, unknown>
  },
): Promise<void> {
  const sidecar = c.get("sidecar")
  await publishDomainEvent(c.env, {
    id: crypto.randomUUID(),
    type: input.type,
    popId: sidecar.popId,
    actorId: c.get("userId"),
    occurredAt: new Date().toISOString(),
    resource: {
      type: input.resourceType ?? "mesas",
      id: input.resourceId,
    },
    payload: input.payload ?? { id: input.resourceId },
    require: { permissions: [...MESAS_REALTIME_READ] },
  })
}

export async function publishMesasEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishMesasEvent>[1],
): Promise<void> {
  try {
    await publishMesasEvent(c, input)
  } catch {
    /* la mutación no falla si el aviso no sale */
  }
}
