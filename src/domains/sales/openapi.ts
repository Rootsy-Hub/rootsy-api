import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { SALE_CREATE } from "./allowlist.js"
import { createSaleBodySchema, createSaleResponseSchema } from "./schema.js"

export const createSaleRoute = documentedRoute({
  method: "post",
  path: "/",
  tags: ["Ventas"],
  summary: "Completar una venta",
  description:
    "Cobra el ticket (snapshot de líneas). Vender, Mesas y Mostrador. Permiso `sale:create`.",
  middleware: [requireMutationPermission(SALE_CREATE)] as const,
  body: createSaleBodySchema,
  success: createSaleResponseSchema,
  successDescription: "Venta registrada.",
})
