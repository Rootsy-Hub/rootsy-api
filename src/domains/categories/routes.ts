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
  return c.json(result, 200)
})

categoryRoutes.openapi(deleteCategoryRoute, async (c) => {
  const result = await deleteCategory(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "categoryId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json({ success: true as const }, 200)
})
