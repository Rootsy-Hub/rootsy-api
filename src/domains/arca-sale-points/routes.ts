import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { ARCA_SALE_POINT_READ, ARCA_SALE_POINT_WRITE } from "./allowlist.js"
import {
  createArcaSalePoint,
  generateArcaSalePointCsr,
  updateArcaSalePoint,
} from "./mutations.js"
import { getArcaSalePoint, listArcaSalePoints } from "./queries.js"
import {
  createArcaSalePointBodySchema,
  updateArcaSalePointBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

function writeCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`invoices:${action}`)
  return {
    canCreate: can("create") || can("update"),
    canUpdate: can("update") || can("create"),
  }
}

export const arcaSalePointRoutes = new Hono<SidecarEnv>()

arcaSalePointRoutes.get("/", requireAnyPermission(ARCA_SALE_POINT_READ), async (c) => {
  const result = await listArcaSalePoints(
    c.get("supabase"),
    c.get("sidecar").popId,
    writeCaps(c.get("sidecar")),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

arcaSalePointRoutes.post(
  "/",
  requireMutationPermission(ARCA_SALE_POINT_WRITE),
  async (c) => {
    const body = createArcaSalePointBodySchema.safeParse(
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
    const result = await createArcaSalePoint(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data.ptoVta,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

arcaSalePointRoutes.get(
  "/:salePointId",
  requireAnyPermission(ARCA_SALE_POINT_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("salePointId"))
    if (!id.success) {
      return c.json({ success: false, error: "salePointId inválido" }, 400)
    }
    const result = await getArcaSalePoint(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

arcaSalePointRoutes.post(
  "/:salePointId/csr",
  requireMutationPermission(ARCA_SALE_POINT_WRITE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("salePointId"))
    if (!id.success) {
      return c.json({ success: false, error: "salePointId inválido" }, 400)
    }
    const result = await generateArcaSalePointCsr(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

arcaSalePointRoutes.patch(
  "/:salePointId",
  requireMutationPermission(ARCA_SALE_POINT_WRITE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("salePointId"))
    if (!id.success) {
      return c.json({ success: false, error: "salePointId inválido" }, 400)
    }
    const body = updateArcaSalePointBodySchema.safeParse(
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
    const result = await updateArcaSalePoint(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
