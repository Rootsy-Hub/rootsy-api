import type { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput } from "../../openapi/valid.js"
import { hasAnyPermission } from "../../sidecar/permissions.js"
import { SALE_CREATE, SALE_READ, SALE_TOOLBOX_READ } from "../sale/allowlist.js"
import {
  findMenuCatalogItemByScan,
  loadMenuCatalog,
  loadMenuCatalogItemsByIds,
  loadMenuCatalogItemsPage,
} from "./catalog.js"
import {
  menuCatalogItemsByIdsRoute,
  menuCatalogItemsRoute,
  menuCatalogRoute,
  menuCatalogScanRoute,
} from "./openapi.js"
import {
  menuCatalogItemsByIdsQuerySchema,
  menuCatalogScanQuerySchema,
  type MenuCatalogItemsQuery,
} from "./schema.js"

function csvUuids(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      ),
    )
}

function menuCatalogCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  return {
    canReadClients: hasAnyPermission(sidecar.keys, SALE_READ, sidecar.isOwner),
    canReadPaymentMethods: hasAnyPermission(
      sidecar.keys,
      SALE_TOOLBOX_READ,
      sidecar.isOwner,
    ),
    canCreateSale: hasAnyPermission(sidecar.keys, SALE_CREATE, sidecar.isOwner),
    canReadCashRegisters: hasAnyPermission(
      sidecar.keys,
      SALE_TOOLBOX_READ,
      sidecar.isOwner,
    ),
  }
}

export const menuCatalogRoutes = createOpenApiApp<SidecarEnv>()

menuCatalogRoutes.openapi(menuCatalogRoute, async (c) => {
  const sidecar = c.get("sidecar")
  const result = await loadMenuCatalog(
    c.get("supabase"),
    sidecar.popId,
    c.get("userId"),
    menuCatalogCaps(sidecar),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

menuCatalogRoutes.openapi(menuCatalogItemsRoute, async (c) => {
  const result = await loadMenuCatalogItemsPage(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<MenuCatalogItemsQuery>(c, "query"),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

menuCatalogRoutes.openapi(menuCatalogItemsByIdsRoute, async (c) => {
  const parsed = routeInput<z.infer<typeof menuCatalogItemsByIdsQuerySchema>>(
    c,
    "query",
  )
  const result = await loadMenuCatalogItemsByIds(
    c.get("supabase"),
    c.get("sidecar").popId,
    csvUuids(parsed.articleIds),
    csvUuids(parsed.recipeIds),
    parsed.priceListId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

menuCatalogRoutes.openapi(menuCatalogScanRoute, async (c) => {
  const parsed = routeInput<z.infer<typeof menuCatalogScanQuerySchema>>(
    c,
    "query",
  )
  const result = await findMenuCatalogItemByScan(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.q,
    parsed.priceListId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})
