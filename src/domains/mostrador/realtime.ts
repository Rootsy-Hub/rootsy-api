import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import type { CounterOrder } from "./schema.js"

export type MostradorEventType =
  | "mostrador.order_opened"
  | "mostrador.order_updated"
  | "mostrador.order_status_changed"
  | "mostrador.checkout_saved"
  | "mostrador.order_closed"

const MOSTRADOR_REALTIME_READ = ["mostrador:read"] as const
const CHECKOUT_PAYLOAD_BUDGET = 6_000

export function orderRealtimeSnapshot(
  order: CounterOrder,
): Record<string, unknown> {
  return {
    id: order.id,
    orderDay: order.orderDay,
    orderNumber: order.orderNumber,
    status: order.status,
    fulfillmentType: order.fulfillmentType,
    deliveryAddress: order.deliveryAddress,
    phone: order.phone,
    driverName: order.driverName,
    estimatedMinutes: order.estimatedMinutes,
    notes: order.notes,
    immediateFulfillment: order.immediateFulfillment,
    saleId: order.saleId,
    openedAt: order.openedAt,
    updatedAt: order.updatedAt,
    deliveredAt: order.deliveredAt,
  }
}

export function checkoutSavedPayload(
  orderId: string,
  updatedAt: string,
  checkout: Record<string, unknown>,
): Record<string, unknown> {
  const withCheckout = { orderId, updatedAt, checkout }
  if (JSON.stringify(withCheckout).length <= CHECKOUT_PAYLOAD_BUDGET) {
    return withCheckout
  }
  return { orderId, updatedAt }
}

export async function publishMostradorEvent(
  c: Context<SidecarEnv>,
  input: {
    type: MostradorEventType
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
    resource: { type: "order", id: input.resourceId },
    payload: input.payload ?? { orderId: input.resourceId },
    require: { permissions: [...MOSTRADOR_REALTIME_READ] },
  })
}

export async function publishMostradorEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishMostradorEvent>[1],
): Promise<void> {
  try {
    await publishMostradorEvent(c, input)
  } catch {
    /* la mutación no falla si el aviso no sale */
  }
}
