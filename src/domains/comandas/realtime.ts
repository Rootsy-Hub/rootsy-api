import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import type { ComandaTicket } from "./schema.js"

const TICKETS_PAYLOAD_BUDGET = 6_000

export function ticketRealtimeSnapshot(
  ticket: ComandaTicket,
): Record<string, unknown> {
  return {
    id: ticket.id,
    stationId: ticket.stationId,
    status: ticket.status,
    sourceKind: ticket.sourceKind,
    sourceId: ticket.sourceId,
    cartLineId: ticket.cartLineId,
    recipeId: ticket.recipeId,
    recipeName: ticket.recipeName,
    quantity: ticket.quantity,
    comment: ticket.comment,
    originLabel: ticket.originLabel,
    customerName: ticket.customerName,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    statusChangedAt: ticket.statusChangedAt,
    sentAt: ticket.sentAt,
    preparingAt: ticket.preparingAt,
    readyAt: ticket.readyAt,
    deliveredAt: ticket.deliveredAt,
    sendId: ticket.sendId,
    sendKind: ticket.sendKind,
    sendComment: ticket.sendComment,
  }
}

export function ticketsPayload(
  tickets: ComandaTicket[],
): ComandaTicket[] | undefined {
  const snaps = tickets.map(ticketRealtimeSnapshot)
  if (JSON.stringify({ tickets: snaps }).length > TICKETS_PAYLOAD_BUDGET) {
    return undefined
  }
  return tickets
}

export type ComandasEventType =
  | "comandas.sent"
  | "comandas.voided"
  | "comandas.status_changed"

const COMANDAS_REALTIME_READ = [
  "comandas:read",
  "mesas:read",
  "mostrador:read",
] as const

export async function publishComandasEvent(
  c: Context<SidecarEnv>,
  input: {
    type: ComandasEventType
    resourceId: string
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
    resource: { type: "comanda", id: input.resourceId },
    payload: input.payload ?? { id: input.resourceId },
    require: { permissions: [...COMANDAS_REALTIME_READ] },
  })
}

export async function publishComandasEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishComandasEvent>[1],
): Promise<void> {
  try {
    await publishComandasEvent(c, input)
  } catch {
    /* la mutación no falla si el aviso no sale */
  }
}
