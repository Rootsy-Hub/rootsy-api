import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  RECIPE_CATEGORY_CREATE,
  RECIPE_CATEGORY_DELETE,
  RECIPE_CATEGORY_READ,
  RECIPE_CATEGORY_UPDATE,
} from "./allowlist.js"
import {
  createRecipeCategory,
  deleteRecipeCategory,
  getRecipeCategory,
  layoutRecipeCategories,
  listRecipeCategories,
  updateRecipeCategory,
} from "./queries.js"
import {
  createRecipeCategoryBodySchema,
  layoutRecipeCategoriesBodySchema,
  listRecipeCategoriesQuerySchema,
  updateRecipeCategoryBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const recipeCategoryRoutes = new Hono<SidecarEnv>()

recipeCategoryRoutes.get(
  "/",
  requireAnyPermission(RECIPE_CATEGORY_READ),
  async (c) => {
    const parsed = listRecipeCategoriesQuerySchema.safeParse({
      showInMenu: c.req.query("showInMenu") || undefined,
      isActive: c.req.query("isActive") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }

    const result = await listRecipeCategories(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

recipeCategoryRoutes.patch(
  "/layout",
  requireMutationPermission(RECIPE_CATEGORY_UPDATE),
  async (c) => {
    const body = layoutRecipeCategoriesBodySchema.safeParse(
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
    const result = await layoutRecipeCategories(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data.updates,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

recipeCategoryRoutes.post(
  "/",
  requireMutationPermission(RECIPE_CATEGORY_CREATE),
  async (c) => {
    const body = createRecipeCategoryBodySchema.safeParse(
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
    const result = await createRecipeCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status ?? 500)
    return c.json(result, 201)
  },
)

recipeCategoryRoutes.get(
  "/:categoryId",
  requireAnyPermission(RECIPE_CATEGORY_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const result = await getRecipeCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

recipeCategoryRoutes.patch(
  "/:categoryId",
  requireMutationPermission(RECIPE_CATEGORY_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const body = updateRecipeCategoryBodySchema.safeParse(
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
    const result = await updateRecipeCategory(
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

recipeCategoryRoutes.delete(
  "/:categoryId",
  requireMutationPermission(RECIPE_CATEGORY_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const result = await deleteRecipeCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
