import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { loadExpensePaymentContext } from "../expenses/paymentContext.js"
import { SALE_CREATE, SALE_READ } from "./allowlist.js"
import {
  findSaleCatalogArticleByScan,
  loadSaleCatalog,
  loadSaleCatalogArticlesByIds,
  loadSaleCatalogItemsPage,
} from "./catalog.js"
import { loadSaleComprobantes } from "./comprobantes.js"
import {
  saleCatalogArticlesQuerySchema,
  saleCatalogItemsQuerySchema,
  saleCatalogScanQuerySchema,
} from "./schema.js"

export const saleRoutes = new Hono<SidecarEnv>()

function saleCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  return {
    canCreateSale:
      sidecar.isOwner || SALE_CREATE.some((key) => sidecar.keys.includes(key)),
  }
}

saleRoutes.get("/catalog", requireAnyPermission(SALE_READ), async (c) => {
  const sidecar = c.get("sidecar")
  const result = await loadSaleCatalog(
    c.get("supabase"),
    sidecar.popId,
    c.get("userId"),
    saleCaps(sidecar),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

saleRoutes.get("/catalog/items", requireAnyPermission(SALE_READ), async (c) => {
  const parsed = saleCatalogItemsQuerySchema.safeParse({
    section: c.req.query("section") || undefined,
    categoryId: c.req.query("categoryId") || undefined,
    categoryIds: c.req.query("categoryIds") || undefined,
    search: c.req.query("search") || undefined,
    priceListId: c.req.query("priceListId") || undefined,
    offset: c.req.query("offset") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const result = await loadSaleCatalogItemsPage(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.data,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

saleRoutes.get("/catalog/articles", requireAnyPermission(SALE_READ), async (c) => {
  const parsed = saleCatalogArticlesQuerySchema.safeParse({
    ids: c.req.query("ids") || undefined,
    priceListId: c.req.query("priceListId") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const ids = parsed.data.ids
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
  const result = await loadSaleCatalogArticlesByIds(
    c.get("supabase"),
    c.get("sidecar").popId,
    ids,
    parsed.data.priceListId,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

saleRoutes.get("/catalog/scan", requireAnyPermission(SALE_READ), async (c) => {
  const parsed = saleCatalogScanQuerySchema.safeParse({
    q: c.req.query("q") || undefined,
    priceListId: c.req.query("priceListId") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const result = await findSaleCatalogArticleByScan(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.data.q,
    parsed.data.priceListId,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

saleRoutes.get(
  "/payment-context",
  requireAnyPermission(SALE_READ),
  async (c) => {
    const result = await loadExpensePaymentContext(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

saleRoutes.get("/comprobantes", requireAnyPermission(SALE_READ), async (c) => {
  const result = await loadSaleComprobantes(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})
