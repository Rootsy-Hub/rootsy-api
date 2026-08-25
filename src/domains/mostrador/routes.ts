import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput, routeParam } from "../../openapi/valid.js"
import { parsePatchBody } from "../../lib/patchBody.js"
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
  return c.json(result, 200)
})

mostradorRoutes.openapi(counterOrderCheckoutRoute, async (c) => {
  const result = await saveCounterOrderCheckout(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "orderId"),
    routeInput<z.infer<typeof counterOrderCheckoutBodySchema>>(c, "json")
      .checkout,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json(result, 200)
})

mostradorRoutes.openapi(closeCounterOrderRoute, async (c) => {
  const result = await closeCounterOrder(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "orderId"),
    routeInput<z.infer<typeof closeCounterOrderBodySchema>>(c, "json").mode,
    c.get("userId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json(result, 200)
})

mostradorRoutes.openapi(cancelCounterOrderRoute, async (c) => {
  const result = await cancelCounterOrder(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "orderId"),
    c.get("userId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json(result, 200)
})
