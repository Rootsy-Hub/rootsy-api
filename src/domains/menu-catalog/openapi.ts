import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { MENU_CATALOG_READ } from "./allowlist.js"
import {
  menuCatalogItemsByIdsQuerySchema,
  menuCatalogItemsByIdsResponseSchema,
  menuCatalogItemsQuerySchema,
  menuCatalogItemsResponseSchema,
  menuCatalogResponseSchema,
  menuCatalogScanQuerySchema,
  menuCatalogScanResponseSchema,
} from "./schema.js"

const tags = ["Catálogo de menú"]
const read = [requireAnyPermission(MENU_CATALOG_READ)] as const

export const menuCatalogRoute = documentedRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Catálogo de menú",
  description:
    "Secciones, promociones y sesión de caja. Permiso `mostrador:read`, `mesas:read`, `sale:read` o `recipes:read`.",
  middleware: read,
  success: menuCatalogResponseSchema,
  successDescription: "Catálogo: recetas, productos y promociones.",
})

export const menuCatalogItemsRoute = documentedRoute({
  method: "get",
  path: "/items",
  tags,
  summary: "Ítems del menú",
  description: "Página de artículos y recetas.",
  middleware: read,
  query: menuCatalogItemsQuerySchema,
  success: menuCatalogItemsResponseSchema,
  successDescription: "Página de artículos y recetas.",
})

export const menuCatalogItemsByIdsRoute = documentedRoute({
  method: "get",
  path: "/items-by-ids",
  tags,
  summary: "Ítems por id",
  description: "`articleIds` y `recipeIds` separados por coma.",
  middleware: read,
  query: menuCatalogItemsByIdsQuerySchema,
  success: menuCatalogItemsByIdsResponseSchema,
  successDescription: "Artículos y recetas pedidos.",
})

export const menuCatalogScanRoute = documentedRoute({
  method: "get",
  path: "/scan",
  tags,
  summary: "Buscar por código o nombre",
  description:
    "Devuelve artículo o receta si hay un único match. Si no, ambos `null`.",
  middleware: read,
  query: menuCatalogScanQuerySchema,
  success: menuCatalogScanResponseSchema,
  successDescription: "Artículo y/o receta encontrados, o `null`.",
})
