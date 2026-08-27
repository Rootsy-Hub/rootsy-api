import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  PROMOTION_CREATE,
  PROMOTION_DELETE,
  PROMOTION_LIST_READ,
  PROMOTION_READ,
  PROMOTION_UPDATE,
} from "./allowlist.js"
import { createPromotion, deletePromotion, updatePromotion } from "./mutations.js"
import { getPromotion, listPromotionCatalog, listPromotions } from "./queries.js"
import {
  promotionRealtimeSnapshot,
  publishPromotionEventBestEffort,
} from "./realtime.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  deletePromotionBodySchema,
  listPromotionsQuerySchema,
  toListPromotionsQuery,
  upsertPromotionBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

function promotionCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`promotions:${action}`)
  return {
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

export const promotionRoutes = new Hono<SidecarEnv>()

promotionRoutes.get("/", requireAnyPermission(PROMOTION_LIST_READ), async (c) => {
  const parsed = listPromotionsQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    soloActivos: c.req.query("soloActivos") || undefined,
    includeSlots: c.req.query("includeSlots") || undefined,
    promotionType: c.req.query("promotionType") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listPromotions(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListPromotionsQuery(parsed.data),
    promotionCaps(c.get("sidecar")),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

promotionRoutes.post("/", requireMutationPermission(PROMOTION_CREATE), async (c) => {
  const body = upsertPromotionBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const sidecar = c.get("sidecar")
  const result = await createPromotion(
    c.get("supabase"),
    sidecar.popId,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  if (result.id) {
    const row = await getPromotion(c.get("supabase"), sidecar.popId, result.id)
    if (row.success) {
      await publishPromotionEventBestEffort(c, {
        type: "promotions.created",
        promotionId: result.id,
        payload: { promotion: promotionRealtimeSnapshot(row.data) },
      })
    }
  }
  return c.json(result, 201)
})

promotionRoutes.get(
  "/catalog",
  requireAnyPermission(PROMOTION_READ),
  async (c) => {
    const result = await listPromotionCatalog(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

promotionRoutes.get(
  "/:promotionId",
  requireAnyPermission(PROMOTION_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("promotionId"))
    if (!id.success) {
      return c.json({ success: false, error: "promotionId inválido" }, 400)
    }
    const result = await getPromotion(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

promotionRoutes.patch(
  "/:promotionId",
  requireMutationPermission(PROMOTION_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("promotionId"))
    if (!id.success) {
      return c.json({ success: false, error: "promotionId inválido" }, 400)
    }
    const body = parsePatchBody(
      upsertPromotionBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await updatePromotion(
      c.get("supabase"),
      sidecar.popId,
      id.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    const row = await getPromotion(c.get("supabase"), sidecar.popId, id.data)
    if (row.success) {
      await publishPromotionEventBestEffort(c, {
        type: "promotions.updated",
        promotionId: id.data,
        payload: { promotion: promotionRealtimeSnapshot(row.data) },
      })
    }
    return c.json(result)
  },
)

promotionRoutes.delete(
  "/:promotionId",
  requireMutationPermission(PROMOTION_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("promotionId"))
    if (!id.success) {
      return c.json({ success: false, error: "promotionId inválido" }, 400)
    }
    const body = deletePromotionBodySchema.safeParse(
      await c.req.json().catch(() => ({ confirmationTyped: "" })),
    )
    if (!body.success) {
      return c.json(
        { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
        400,
      )
    }
    const result = await deletePromotion(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data.confirmationTyped,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    await publishPromotionEventBestEffort(c, {
      type: "promotions.deleted",
      promotionId: id.data,
      payload: { promotionId: id.data },
    })
    return c.json(result)
  },
)
