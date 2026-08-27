import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput } from "../../openapi/valid.js"
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
  return c.json(
    {
      success: true as const,
      data: { saleId: result.saleId, replayed: result.replayed },
    },
    201,
  )
})
