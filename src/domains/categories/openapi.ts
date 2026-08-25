import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  CATEGORY_CREATE,
  CATEGORY_DELETE,
  CATEGORY_READ,
  CATEGORY_UPDATE,
} from "./allowlist.js"
import {
  categoryDetailResponseSchema,
  categoryListResponseSchema,
  categoryResponseSchema,
  createCategoryBodySchema,
  layoutCategoriesBodySchema,
  listCategoriesQuerySchema,
  updateCategoryBodySchema,
} from "./schema.js"

const tags = ["Categorías"]
const read = [requireAnyPermission(CATEGORY_READ)] as const
const create = [requireMutationPermission(CATEGORY_CREATE)] as const
const update = [requireMutationPermission(CATEGORY_UPDATE)] as const
const remove = [requireMutationPermission(CATEGORY_DELETE)] as const

export const listCategoriesRoute = documentedRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Listar categorías de artículos",
  description:
    "Filtros opcionales por tipo y visibilidad. Lectura con `articles:read`, `mesas:read`, `sale:read`, `mostrador:read`, `cash_registers:read` o `inventory:read`.",
  middleware: read,
  query: listCategoriesQuerySchema,
  success: categoryListResponseSchema,
  successDescription: "Categorías del local.",
})

export const createCategoryRoute = documentedRoute({
  method: "post",
  path: "/",
  tags,
  summary: "Crear categoría de artículos",
  description: "Permiso `articles:create` (o aprobación).",
  middleware: create,
  body: createCategoryBodySchema,
  success: categoryResponseSchema,
  successDescription: "Categoría creada.",
})

export const layoutCategoriesRoute = documentedRoute({
  method: "patch",
  path: "/layout",
  tags,
  summary: "Reordenar categorías",
  description:
    "Actualiza `sortOrder` y `showInSale` (también replica a `showInMenu`). Permiso `articles:update` (o aprobación).",
  middleware: update,
  body: layoutCategoriesBodySchema,
})

export const getCategoryRoute = documentedRoute({
  method: "get",
  path: "/{categoryId}",
  tags,
  summary: "Obtener categoría de artículos",
  description: "Incluye `articleCount`. Misma lectura que el listado.",
  middleware: read,
  success: categoryDetailResponseSchema,
  successDescription: "Categoría con cantidad de artículos.",
})

export const updateCategoryRoute = documentedRoute({
  method: "patch",
  path: "/{categoryId}",
  tags,
  summary: "Actualizar categoría de artículos",
  description:
    "Hay que mandar al menos un campo. Permiso `articles:update` (o aprobación).",
  middleware: update,
  body: updateCategoryBodySchema,
  success: categoryResponseSchema,
  successDescription: "Categoría actualizada.",
})

export const deleteCategoryRoute = documentedRoute({
  method: "delete",
  path: "/{categoryId}",
  tags,
  summary: "Eliminar categoría de artículos",
  description:
    "409 si tiene artículos. Permiso `articles:delete` (o aprobación).",
  middleware: remove,
})
