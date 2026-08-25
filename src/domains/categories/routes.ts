import type { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput, routeParam } from "../../openapi/valid.js"
import {
  createCategory,
  deleteCategory,
  getCategory,
  layoutCategories,
  listCategories,
  updateCategory,
} from "./queries.js"
import {
  categoryRealtimePayload,
  publishCategoryEvent,
} from "./realtime.js"
import {
  createCategoryRoute,
  deleteCategoryRoute,
  getCategoryRoute,
  layoutCategoriesRoute,
  listCategoriesRoute,
  updateCategoryRoute,
} from "./openapi.js"
import {
  createCategoryBodySchema,
  layoutCategoriesBodySchema,
  listCategoriesQuerySchema,
  toListCategoriesQuery,
  updateCategoryBodySchema,
} from "./schema.js"

export const categoryRoutes = createOpenApiApp<SidecarEnv>()

categoryRoutes.openapi(listCategoriesRoute, async (c) => {
  const result = await listCategories(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListCategoriesQuery(
      routeInput<z.infer<typeof listCategoriesQuerySchema>>(c, "query"),
    ),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

categoryRoutes.openapi(createCategoryRoute, async (c) => {
  const result = await createCategory(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof createCategoryBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  void publishCategoryEvent(c, {
    type: "categories.created",
    categoryId: result.data.id,
    payload: categoryRealtimePayload(result.data),
  }).catch(() => undefined)
  return c.json(result, 201)
})

categoryRoutes.openapi(layoutCategoriesRoute, async (c) => {
  const body = routeInput<z.infer<typeof layoutCategoriesBodySchema>>(c, "json")
  const result = await layoutCategories(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.updates,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  for (const update of body.updates) {
    void publishCategoryEvent(c, {
      type: "categories.updated",
      categoryId: update.id,
      payload: {
        category: {
          id: update.id,
          sortOrder: update.sortOrder,
          showInSale: update.showInSale,
        },
      },
    }).catch(() => undefined)
  }
  return c.json({ success: true as const }, 200)
})

categoryRoutes.openapi(getCategoryRoute, async (c) => {
  const result = await getCategory(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "categoryId"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json(result, 200)
})

categoryRoutes.openapi(updateCategoryRoute, async (c) => {
  const result = await updateCategory(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "categoryId"),
    routeInput<z.infer<typeof updateCategoryBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  void publishCategoryEvent(c, {
    type: "categories.updated",
    categoryId: result.data.id,
    payload: categoryRealtimePayload(result.data),
  }).catch(() => undefined)
  return c.json(result, 200)
})

categoryRoutes.openapi(deleteCategoryRoute, async (c) => {
  const categoryId = routeParam(c, "categoryId")
  const result = await deleteCategory(
    c.get("supabase"),
    c.get("sidecar").popId,
    categoryId,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  void publishCategoryEvent(c, {
    type: "categories.deleted",
    categoryId,
    payload: { categoryId },
  }).catch(() => undefined)
  return c.json({ success: true as const }, 200)
})
