import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  PRICE_LIST_CREATE,
  PRICE_LIST_DELETE,
  PRICE_LIST_READ,
  PRICE_LIST_UPDATE,
} from "./allowlist.js"
import {
  createPriceList,
  deletePriceList,
  listPriceLists,
  updatePriceList,
} from "./queries.js"
import {
  createPriceListBodySchema,
  updatePriceListBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const priceListRoutes = new Hono<SidecarEnv>()

priceListRoutes.get("/", requireAnyPermission(PRICE_LIST_READ), async (c) => {
  const result = await listPriceLists(c.get("supabase"), c.get("sidecar").popId)
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

priceListRoutes.post("/", requireAnyPermission(PRICE_LIST_CREATE), async (c) => {
  const body = createPriceListBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await createPriceList(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

priceListRoutes.patch(
  "/:listId",
  requireAnyPermission(PRICE_LIST_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("listId"))
    if (!id.success) {
      return c.json({ success: false, error: "listId inválido" }, 400)
    }
    const body = updatePriceListBodySchema.safeParse(
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
    const result = await updatePriceList(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

priceListRoutes.delete(
  "/:listId",
  requireAnyPermission(PRICE_LIST_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("listId"))
    if (!id.success) {
      return c.json({ success: false, error: "listId inválido" }, 400)
    }
    const result = await deletePriceList(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
