import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { SALE_READ, SALE_TOOLBOX_READ } from "./allowlist.js"
import {
  saleCatalogArticlesQuerySchema,
  saleCatalogArticlesResponseSchema,
  saleCatalogItemsQuerySchema,
  saleCatalogItemsResponseSchema,
  saleCatalogResponseSchema,
  saleCatalogScanQuerySchema,
  saleCatalogScanResponseSchema,
  saleComprobantesResponseSchema,
  salePaymentContextResponseSchema,
} from "./schema.js"

const tags = ["Venta"]
const read = [requireAnyPermission(SALE_READ)] as const
const toolbox = [requireAnyPermission(SALE_TOOLBOX_READ)] as const

export const saleCatalogRoute = documentedRoute({
  method: "get",
  path: "/catalog",
  tags,
  summary: "Catálogo de venta",
  description: "Categorías, promociones y sesión de caja. Permiso `sale:read`.",
  middleware: read,
  success: saleCatalogResponseSchema,
  successDescription: "Catálogo: categorías, promociones y sesión de caja.",
})

export const saleCatalogItemsRoute = documentedRoute({
  method: "get",
  path: "/catalog/items",
  tags,
  summary: "Ítems del catálogo",
  description: "Página de artículos/recetas. Permiso `sale:read`.",
  middleware: read,
  query: saleCatalogItemsQuerySchema,
  success: saleCatalogItemsResponseSchema,
  successDescription: "Página de artículos.",
})

export const saleCatalogArticlesRoute = documentedRoute({
  method: "get",
  path: "/catalog/articles",
  tags,
  summary: "Artículos por id",
  description: "`ids` separados por coma. Permiso `sale:read`.",
  middleware: read,
  query: saleCatalogArticlesQuerySchema,
  success: saleCatalogArticlesResponseSchema,
  successDescription: "Artículos pedidos.",
})

export const saleCatalogScanRoute = documentedRoute({
  method: "get",
  path: "/catalog/scan",
  tags,
  summary: "Buscar por código o nombre",
  description:
    "Devuelve el artículo si hay un único match, o `null`. Permiso `sale:read`.",
  middleware: read,
  query: saleCatalogScanQuerySchema,
  success: saleCatalogScanResponseSchema,
  successDescription: "Artículo encontrado, o `null`.",
})

export const salePaymentContextRoute = documentedRoute({
  method: "get",
  path: "/payment-context",
  tags,
  summary: "Contexto de pago",
  description: "Toolbox: `sale:read`, `mostrador:read` o `mesas:read`.",
  middleware: toolbox,
  success: salePaymentContextResponseSchema,
  successDescription: "Cuentas de tesorería para cobrar.",
})

export const saleComprobantesRoute = documentedRoute({
  method: "get",
  path: "/comprobantes",
  tags,
  summary: "Opciones de comprobante",
  description: "Toolbox: `sale:read`, `mostrador:read` o `mesas:read`.",
  middleware: toolbox,
  success: saleComprobantesResponseSchema,
  successDescription:
    "Opciones de comprobante y datos fiscales del emisor para la vista previa.",
})
