import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput, routeParam } from "../../openapi/valid.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  checkoutSavedPayload,
  orderRealtimeSnapshot,
  publishMostradorEventBestEffort,
} from "./realtime.js"
import {
  cancelCounterOrder,
  closeCounterOrder,
  createCounterOrder,
  saveCounterOrderCheckout,
  updateCounterOrder,
  updateCounterOrderStatus,
} from "./mutations.js"
import { getCounterOrder, listCounterOrders } from "./queries.js"
import {
  cancelCounterOrderRoute,
  closeCounterOrderRoute,
  counterOrderCheckoutRoute,
  counterOrderStatusRoute,
  createCounterOrderRoute,
  getCounterOrderRoute,
  listCounterOrdersRoute,
  patchCounterOrderRoute,
} from "./openapi.js"
import {
  closeCounterOrderBodySchema,
  counterOrderCheckoutBodySchema,
  counterOrderStatusBodySchema,
  createCounterOrderBodySchema,
  type CreateCounterOrderBody,
} from "./schema.js"
import type { z } from "zod"

export const mostradorRoutes = createOpenApiApp<SidecarEnv>()

mostradorRoutes.openapi(listCounterOrdersRoute, async (c) => {
  const result = await listCounterOrders(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mostradorRoutes.openapi(createCounterOrderRoute, async (c) => {
  const result = await createCounterOrder(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    routeInput<CreateCounterOrderBody>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  if (result.data.order) {
    await publishMostradorEventBestEffort(c, {
      type: "mostrador.order_opened",
      resourceId: result.data.order.id,
      payload: { order: orderRealtimeSnapshot(result.data.order) },
    })
  }
  return c.json(result, 201)
})

mostradorRoutes.openapi(getCounterOrderRoute, async (c) => {
  const result = await getCounterOrder(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "orderId"),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mostradorRoutes.openapi(patchCounterOrderRoute, async (c) => {
  const parsed = parsePatchBody(
    createCounterOrderBodySchema,
    await c.req.json().catch(() => null),
  )
  if (!parsed.success) return apiFail(c, parsed.error, 400)
  const result = await updateCounterOrder(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "orderId"),
    parsed.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  if (result.data.order) {
    await publishMostradorEventBestEffort(c, {
      type: "mostrador.order_updated",
      resourceId: result.data.order.id,
      payload: { order: orderRealtimeSnapshot(result.data.order) },
    })
  }
  return c.json(result, 200)
})

mostradorRoutes.openapi(counterOrderStatusRoute, async (c) => {
  const result = await updateCounterOrderStatus(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "orderId"),
    routeInput<z.infer<typeof counterOrderStatusBodySchema>>(c, "json").status,
    c.get("userId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  const statusOrderId = routeParam(c, "orderId")
  if (result.data.order?.status === "cancelled" || !result.data.order) {
    await publishMostradorEventBestEffort(c, {
      type: "mostrador.order_closed",
      resourceId: result.data.order?.id ?? statusOrderId,
      payload: {
        orderId: result.data.order?.id ?? statusOrderId,
        reason: "cancelled",
      },
    })
  } else {
    await publishMostradorEventBestEffort(c, {
      type: "mostrador.order_status_changed",
      resourceId: result.data.order.id,
      payload: {
        orderId: result.data.order.id,
        status: result.data.order.status,
        deliveredAt: result.data.order.deliveredAt,
        updatedAt: result.data.order.updatedAt,
      },
    })
  }
  return c.json(result, 200)
})

mostradorRoutes.openapi(counterOrderCheckoutRoute, async (c) => {
  const checkout = routeInput<
    z.infer<typeof counterOrderCheckoutBodySchema>
  >(c, "json").checkout
  const orderId = routeParam(c, "orderId")
  const result = await saveCounterOrderCheckout(
    c.get("supabase"),
    c.get("sidecar").popId,
    orderId,
    checkout,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  if (result.data.updatedAt) {
    await publishMostradorEventBestEffort(c, {
      type: "mostrador.checkout_saved",
      resourceId: orderId,
      payload: checkoutSavedPayload(orderId, result.data.updatedAt, checkout),
    })
  }
  return c.json(result, 200)
})

mostradorRoutes.openapi(closeCounterOrderRoute, async (c) => {
  const orderId = routeParam(c, "orderId")
  const mode = routeInput<z.infer<typeof closeCounterOrderBodySchema>>(c, "json")
    .mode
  const result = await closeCounterOrder(
    c.get("supabase"),
    c.get("sidecar").popId,
    orderId,
    mode,
    c.get("userId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMostradorEventBestEffort(c, {
    type: "mostrador.order_closed",
    resourceId: orderId,
    payload: {
      orderId,
      reason: mode === "settle" ? "settled" : "cancelled",
    },
  })
  return c.json(result, 200)
})

mostradorRoutes.openapi(cancelCounterOrderRoute, async (c) => {
  const orderId = routeParam(c, "orderId")
  const result = await cancelCounterOrder(
    c.get("supabase"),
    c.get("sidecar").popId,
    orderId,
    c.get("userId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMostradorEventBestEffort(c, {
    type: "mostrador.order_closed",
    resourceId: orderId,
    payload: { orderId, reason: "cancelled" },
  })
  return c.json(result, 200)
})
