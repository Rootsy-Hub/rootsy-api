import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { hasAnyPermission, requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { MANUFACTURING_CREATE, MANUFACTURING_READ } from "./allowlist.js"
import { createManufacturingRun } from "./mutations.js"
import { listManufacturableRecipes, listManufacturingWorkspace } from "./queries.js"
import {
  createManufacturingRunBodySchema,
  listManufacturingQuerySchema,
  MANUFACTURING_RECIPE_SEARCH_LIMIT,
  searchManufacturingRecipesQuerySchema,
} from "./schema.js"

export const manufacturingRoutes = new Hono<SidecarEnv>()

manufacturingRoutes.get("/", requireAnyPermission(MANUFACTURING_READ), async (c) => {
  const parsed = listManufacturingQuerySchema.safeParse({
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const sidecar = c.get("sidecar")
  const canCreate =
    sidecar.isOwner || hasAnyPermission(sidecar.keys, MANUFACTURING_CREATE, false)

  const result = await listManufacturingWorkspace(
    c.get("supabase"),
    sidecar.popId,
    { from: parsed.data.from, to: parsed.data.to },
    { canCreate },
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

manufacturingRoutes.get(
  "/recipes",
  requireAnyPermission(MANUFACTURING_READ),
  async (c) => {
    const parsed = searchManufacturingRecipesQuerySchema.safeParse({
      q: c.req.query("q") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await listManufacturableRecipes(
      c.get("supabase"),
      c.get("sidecar").popId,
      {
        search: parsed.data.q,
        limit: MANUFACTURING_RECIPE_SEARCH_LIMIT,
      },
    )
    if (!result.success) return c.json(result, result.status)
    return c.json({ success: true, data: { recipes: result.recipes } })
  },
)

manufacturingRoutes.post(
  "/",
  requireMutationPermission(MANUFACTURING_CREATE),
  async (c) => {
    const body = createManufacturingRunBodySchema.safeParse(
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
    const result = await createManufacturingRun(
      c.get("supabase"),
      sidecar.popId,
      c.get("userId"),
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)
