import type { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput } from "../../openapi/valid.js"
import { loadExpensePaymentContext } from "../expenses/paymentContext.js"
import { SALE_CREATE } from "./allowlist.js"
import {
  findSaleCatalogArticleByScan,
  loadSaleCatalog,
  loadSaleCatalogArticlesByIds,
  loadSaleCatalogItemsPage,
} from "./catalog.js"
import { loadSaleComprobantes } from "./comprobantes.js"
import {
  saleCatalogArticlesRoute,
  saleCatalogItemsRoute,
  saleCatalogRoute,
  saleCatalogScanRoute,
  saleComprobantesRoute,
  salePaymentContextRoute,
} from "./openapi.js"
import {
  saleCatalogArticlesQuerySchema,
  saleCatalogScanQuerySchema,
  type SaleCatalogItemsQuery,
} from "./schema.js"

function saleCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  return {
    canCreateSale:
      sidecar.isOwner || SALE_CREATE.some((key) => sidecar.keys.includes(key)),
  }
}

export const saleRoutes = createOpenApiApp<SidecarEnv>()

saleRoutes.openapi(saleCatalogRoute, async (c) => {
  const sidecar = c.get("sidecar")
  const result = await loadSaleCatalog(
    c.get("supabase"),
    sidecar.popId,
    c.get("userId"),
    saleCaps(sidecar),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

saleRoutes.openapi(saleCatalogItemsRoute, async (c) => {
  const result = await loadSaleCatalogItemsPage(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<SaleCatalogItemsQuery>(c, "query"),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

saleRoutes.openapi(saleCatalogArticlesRoute, async (c) => {
  const parsed = routeInput<z.infer<typeof saleCatalogArticlesQuerySchema>>(
    c,
    "query",
  )
  const ids = parsed.ids
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
  const result = await loadSaleCatalogArticlesByIds(
    c.get("supabase"),
    c.get("sidecar").popId,
    ids,
    parsed.priceListId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

saleRoutes.openapi(saleCatalogScanRoute, async (c) => {
  const parsed = routeInput<z.infer<typeof saleCatalogScanQuerySchema>>(
    c,
    "query",
  )
  const result = await findSaleCatalogArticleByScan(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.q,
    parsed.priceListId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

saleRoutes.openapi(salePaymentContextRoute, async (c) => {
  const result = await loadExpensePaymentContext(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

saleRoutes.openapi(saleComprobantesRoute, async (c) => {
  const result = await loadSaleComprobantes(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})
