import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput } from "../../openapi/valid.js"
import { publishMesasEventBestEffort } from "../mesas/realtime.js"
import { publishMostradorEventBestEffort } from "../mostrador/realtime.js"
import { completeSale } from "./complete.js"
import { createSaleRoute } from "./openapi.js"
import type { CreateSaleBody } from "./schema.js"

export const salesRoutes = createOpenApiApp<SidecarEnv>()

salesRoutes.openapi(createSaleRoute, async (c) => {
  const sidecar = c.get("sidecar")
  const result = await completeSale(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    c.get("userId"),
    routeInput<CreateSaleBody>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  if (result.closedTableSessionId) {
    await publishMesasEventBestEffort(c, {
      type: "mesas.session_closed",
      resourceId: result.closedTableSessionId,
      resourceType: "session",
      payload: { sessionId: result.closedTableSessionId },
    })
  }
  if (result.linkedCounterOrderId) {
    await publishMostradorEventBestEffort(c, {
      type: "mostrador.order_closed",
      resourceId: result.linkedCounterOrderId,
      payload: {
        orderId: result.linkedCounterOrderId,
        reason: "sale_linked",
        saleId: result.saleId,
      },
    })
  }
  return c.json(
    {
      success: true as const,
      data: { saleId: result.saleId, replayed: result.replayed },
    },
    201,
  )
})
