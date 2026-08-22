import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  PURCHASE_ORDER_CREATE,
  PURCHASE_ORDER_DELETE,
  PURCHASE_ORDER_READ,
} from "./allowlist.js"
import { createPurchaseOrder, deletePurchaseOrder } from "./mutations.js"
import { getPurchaseOrder, listPurchaseOrders } from "./queries.js"
import {
  createPurchaseOrderBodySchema,
  listPurchaseOrdersQuerySchema,
  toListPurchaseOrdersQuery,
} from "./schema.js"

const idSchema = z.string().uuid()

export const purchaseOrderRoutes = new Hono<SidecarEnv>()

purchaseOrderRoutes.get("/", requireAnyPermission(PURCHASE_ORDER_READ), async (c) => {
  const parsed = listPurchaseOrdersQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    dateFrom: c.req.query("dateFrom") || undefined,
    dateTo: c.req.query("dateTo") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const sidecar = c.get("sidecar")
  const result = await listPurchaseOrders(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    toListPurchaseOrdersQuery(parsed.data),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

purchaseOrderRoutes.post(
  "/",
  requireAnyPermission(PURCHASE_ORDER_CREATE),
  async (c) => {
    const body = createPurchaseOrderBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json(
        {
          success: false,
          error: body.error.issues[0]?.message ?? "Body inválido",
        },
        400,
      )
    }
    const result = await createPurchaseOrder(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

purchaseOrderRoutes.get(
  "/:orderId",
  requireAnyPermission(PURCHASE_ORDER_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("orderId"))
    if (!id.success) {
      return c.json({ success: false, error: "orderId inválido" }, 400)
    }
    const result = await getPurchaseOrder(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

purchaseOrderRoutes.delete(
  "/:orderId",
  requireAnyPermission(PURCHASE_ORDER_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("orderId"))
    if (!id.success) {
      return c.json({ success: false, error: "orderId inválido" }, 400)
    }
    const result = await deletePurchaseOrder(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
