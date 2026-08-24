import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  SERVICE_CATEGORY_CREATE,
  SERVICE_CATEGORY_DELETE,
  SERVICE_CATEGORY_READ,
  SERVICE_CATEGORY_UPDATE,
} from "./allowlist.js"
import {
  createServiceCategory,
  deleteServiceCategory,
  getServiceCategory,
  listServiceCategories,
  updateServiceCategory,
} from "./queries.js"
import {
  createServiceCategoryBodySchema,
  listServiceCategoriesQuerySchema,
  updateServiceCategoryBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const serviceCategoryRoutes = new Hono<SidecarEnv>()

serviceCategoryRoutes.get(
  "/",
  requireAnyPermission(SERVICE_CATEGORY_READ),
  async (c) => {
    const parsed = listServiceCategoriesQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      includeDeleted: c.req.query("includeDeleted") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }

    const result = await listServiceCategories(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

serviceCategoryRoutes.get(
  "/:categoryId",
  requireAnyPermission(SERVICE_CATEGORY_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const result = await getServiceCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

serviceCategoryRoutes.post(
  "/",
  requireMutationPermission(SERVICE_CATEGORY_CREATE),
  async (c) => {
    const body = createServiceCategoryBodySchema.safeParse(
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
    const result = await createServiceCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result, 201)
  },
)

serviceCategoryRoutes.patch(
  "/:categoryId",
  requireMutationPermission(SERVICE_CATEGORY_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const body = updateServiceCategoryBodySchema.safeParse(
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
    const result = await updateServiceCategory(
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

serviceCategoryRoutes.delete(
  "/:categoryId",
  requireMutationPermission(SERVICE_CATEGORY_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const result = await deleteServiceCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
