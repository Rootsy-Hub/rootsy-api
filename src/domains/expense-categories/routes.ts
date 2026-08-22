import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  EXPENSE_CATEGORY_CREATE,
  EXPENSE_CATEGORY_DELETE,
  EXPENSE_CATEGORY_READ,
  EXPENSE_CATEGORY_UPDATE,
} from "./allowlist.js"
import {
  createExpenseCategory,
  deleteExpenseCategory,
  getExpenseCategory,
  listExpenseCategories,
  updateExpenseCategory,
} from "./queries.js"
import {
  createExpenseCategoryBodySchema,
  listExpenseCategoriesQuerySchema,
  updateExpenseCategoryBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const expenseCategoryRoutes = new Hono<SidecarEnv>()

expenseCategoryRoutes.get(
  "/",
  requireAnyPermission(EXPENSE_CATEGORY_READ),
  async (c) => {
    const parsed = listExpenseCategoriesQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      includeDeleted: c.req.query("includeDeleted") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }

    const result = await listExpenseCategories(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

expenseCategoryRoutes.get(
  "/:categoryId",
  requireAnyPermission(EXPENSE_CATEGORY_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const result = await getExpenseCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

expenseCategoryRoutes.post(
  "/",
  requireAnyPermission(EXPENSE_CATEGORY_CREATE),
  async (c) => {
    const body = createExpenseCategoryBodySchema.safeParse(
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
    const result = await createExpenseCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
    )
    if (!result.success) return c.json(result, result.status ?? 500)
    return c.json(result, 201)
  },
)

expenseCategoryRoutes.patch(
  "/:categoryId",
  requireAnyPermission(EXPENSE_CATEGORY_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const body = updateExpenseCategoryBodySchema.safeParse(
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
    const result = await updateExpenseCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

expenseCategoryRoutes.delete(
  "/:categoryId",
  requireAnyPermission(EXPENSE_CATEGORY_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("categoryId"))
    if (!id.success) {
      return c.json({ success: false, error: "categoryId inválido" }, 400)
    }
    const result = await deleteExpenseCategory(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
