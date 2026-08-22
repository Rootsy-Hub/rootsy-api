import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  ARTICLE_UPDATE,
  INVENTORY_CREATE,
  INVENTORY_DELETE,
  INVENTORY_READ,
  INVENTORY_READ_OR_CREATE,
  INVENTORY_UPDATE,
  INVENTORY_WRITE_EXPIRY,
} from "./allowlist.js"
import { setInventoryLayerExpiry } from "./expiryMutations.js"
import {
  archiveInventoryLocation,
  createInventoryLocation,
  renameInventoryLocation,
  transferInventoryStock,
} from "./locationMutations.js"
import {
  applyInventoryMinStockRecommendations,
  createInventoryAdjustment,
  deleteInventoryMovement,
} from "./mutations.js"
import {
  getArticleInventoryBalance,
  listInventoryExpiryLayers,
  listInventoryLedgerAllocations,
  listInventoryLedgerLayers,
  listInventoryLocations,
  listInventoryMovements,
  listInventoryRows,
  listInventorySummary,
  searchInventoryArticles,
} from "./queries.js"
import {
  applyMinStockBodySchema,
  balanceQuerySchema,
  createAdjustmentBodySchema,
  createLocationBodySchema,
  listExpiryQuerySchema,
  listLedgerQuerySchema,
  listMovementsQuerySchema,
  listRowsQuerySchema,
  renameLocationBodySchema,
  searchArticlesQuerySchema,
  setExpiryBodySchema,
  transferBodySchema,
} from "./schema.js"
import { entryDateIsoInTimezone, timezoneForPopLedger } from "./timezone.js"

const idSchema = z.string().uuid()

export const inventoryRoutes = new Hono<SidecarEnv>()

inventoryRoutes.get(
  "/rows",
  requireAnyPermission(INVENTORY_READ),
  async (c) => {
    const parsed = listRowsQuerySchema.safeParse({
      view: c.req.query("view") || undefined,
      q: c.req.query("q") || undefined,
      page: c.req.query("page") || undefined,
      pageSize: c.req.query("pageSize") || undefined,
      attention: c.req.query("attention") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await listInventoryRows(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

inventoryRoutes.get(
  "/expiry",
  requireAnyPermission(INVENTORY_READ),
  async (c) => {
    const parsed = listExpiryQuerySchema.safeParse({
      page: c.req.query("page") || undefined,
      pageSize: c.req.query("pageSize") || undefined,
      q: c.req.query("q") || undefined,
      filter: c.req.query("filter") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const todayIso = entryDateIsoInTimezone(
      timezoneForPopLedger(null, sidecar.popSiteId),
    )
    const result = await listInventoryExpiryLayers(
      c.get("supabase"),
      sidecar.popId,
      parsed.data,
      todayIso,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

inventoryRoutes.get(
  "/summary",
  requireAnyPermission(INVENTORY_READ),
  async (c) => {
    const sidecar = c.get("sidecar")
    const todayIso = entryDateIsoInTimezone(
      timezoneForPopLedger(null, sidecar.popSiteId),
    )
    const result = await listInventorySummary(
      c.get("supabase"),
      sidecar.popId,
      todayIso,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

inventoryRoutes.get(
  "/movements",
  requireAnyPermission(INVENTORY_READ),
  async (c) => {
    const parsed = listMovementsQuerySchema.safeParse({
      page: c.req.query("page") || undefined,
      pageSize: c.req.query("pageSize") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await listInventoryMovements(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

inventoryRoutes.get("/ledger", requireAnyPermission(INVENTORY_READ), async (c) => {
  const parsed = listLedgerQuerySchema.safeParse({
    kind: c.req.query("kind") || undefined,
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const result =
    parsed.data.kind === "allocations"
      ? await listInventoryLedgerAllocations(
          c.get("supabase"),
          c.get("sidecar").popId,
          parsed.data,
        )
      : await listInventoryLedgerLayers(
          c.get("supabase"),
          c.get("sidecar").popId,
          parsed.data,
        )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

inventoryRoutes.get(
  "/locations",
  requireAnyPermission(INVENTORY_READ),
  async (c) => {
    const result = await listInventoryLocations(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

inventoryRoutes.get(
  "/articles",
  requireAnyPermission(INVENTORY_READ_OR_CREATE),
  async (c) => {
    const parsed = searchArticlesQuerySchema.safeParse({
      q: c.req.query("q") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await searchInventoryArticles(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data.q,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

inventoryRoutes.get(
  "/balance",
  requireAnyPermission(INVENTORY_READ_OR_CREATE),
  async (c) => {
    const parsed = balanceQuerySchema.safeParse({
      articleId: c.req.query("articleId") || undefined,
      locationId: c.req.query("locationId") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await getArticleInventoryBalance(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data.articleId,
      parsed.data.locationId,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

inventoryRoutes.post(
  "/adjustments",
  requireAnyPermission(INVENTORY_CREATE),
  async (c) => {
    const body = createAdjustmentBodySchema.safeParse(
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
    const sidecar = c.get("sidecar")
    const result = await createInventoryAdjustment(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      c.get("userId"),
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

inventoryRoutes.post(
  "/min-stock",
  requireAnyPermission(ARTICLE_UPDATE),
  async (c) => {
    const body = applyMinStockBodySchema.safeParse(
      await c.req.json().catch(() => ({})),
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
    const result = await applyInventoryMinStockRecommendations(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

inventoryRoutes.post(
  "/transfers",
  requireAnyPermission(INVENTORY_CREATE),
  async (c) => {
    const body = transferBodySchema.safeParse(
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
    const result = await transferInventoryStock(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

inventoryRoutes.post(
  "/locations",
  requireAnyPermission(INVENTORY_CREATE),
  async (c) => {
    const body = createLocationBodySchema.safeParse(
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
    const result = await createInventoryLocation(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data.name,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

inventoryRoutes.patch(
  "/locations/:locationId",
  requireAnyPermission(INVENTORY_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("locationId"))
    if (!id.success) {
      return c.json({ success: false, error: "locationId inválido" }, 400)
    }
    const body = renameLocationBodySchema.safeParse(
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
    const result = await renameInventoryLocation(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data.name,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

inventoryRoutes.post(
  "/locations/:locationId/archive",
  requireAnyPermission(INVENTORY_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("locationId"))
    if (!id.success) {
      return c.json({ success: false, error: "locationId inválido" }, 400)
    }
    const result = await archiveInventoryLocation(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

inventoryRoutes.delete(
  "/movements/:movementId",
  requireAnyPermission(INVENTORY_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("movementId"))
    if (!id.success) {
      return c.json({ success: false, error: "movementId inválido" }, 400)
    }
    const result = await deleteInventoryMovement(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

inventoryRoutes.patch(
  "/layers/:layerId/expiry",
  requireAnyPermission(INVENTORY_WRITE_EXPIRY),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("layerId"))
    if (!id.success) {
      return c.json({ success: false, error: "layerId inválido" }, 400)
    }
    const body = setExpiryBodySchema.safeParse(
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
    const result = await setInventoryLayerExpiry(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
