import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  CATEGORY_CREATE,
  CATEGORY_DELETE,
  CATEGORY_READ,
  CATEGORY_UPDATE,
} from "./allowlist.js"
import {
  createCategory,
  deleteCategory,
  getCategory,
  layoutCategories,
  listCategories,
  updateCategory,
} from "./queries.js"
import {
  createCategoryBodySchema,
  layoutCategoriesBodySchema,
  listCategoriesQuerySchema,
  updateCategoryBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const categoryRoutes = new Hono<SidecarEnv>()

categoryRoutes.get("/", requireAnyPermission(CATEGORY_READ), async (c) => {
  const parsed = listCategoriesQuerySchema.safeParse({
    itemKind: c.req.query("itemKind") || undefined,
    showInSale: c.req.query("showInSale") || undefined,
    showInMenu: c.req.query("showInMenu") || undefined,
    visible: c.req.query("visible") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listCategories(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.data,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

categoryRoutes.get("/:categoryId", requireAnyPermission(CATEGORY_READ), async (c) => {
  const id = idSchema.safeParse(c.req.param("categoryId"))
  if (!id.success) {
    return c.json({ success: false, error: "categoryId inválido" }, 400)
  }
  const result = await getCategory(
    c.get("supabase"),
    c.get("sidecar").popId,
    id.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

categoryRoutes.post("/", requireAnyPermission(CATEGORY_CREATE), async (c) => {
  const body = createCategoryBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await createCategory(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result, 201)
})

categoryRoutes.patch(
  "/layout",
  requireAnyPermission(CATEGORY_UPDATE),
  async (c) => {
    const body = layoutCategoriesBodySchema.safeParse(
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
    const result = await layoutCategories(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data.updates,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

categoryRoutes.patch(
  "/:categoryId",
  requireAnyPermission(CATEGORY_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const body = updateCategoryBodySchema.safeParse(
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
    const result = await updateCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

categoryRoutes.delete(
  "/:categoryId",
  requireAnyPermission(CATEGORY_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const result = await deleteCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
