import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { CATALOG_REALTIME_READ } from "../../realtime/catalogAcl.js"
import type { RecipeCategoryRow } from "./schema.js"

export type CatalogRecipeCategoryEventType =
  | "recipecategories.created"
  | "recipecategories.updated"
  | "recipecategories.deleted"
  | "recipecategories.layout"

const RECIPE_CATEGORY_REALTIME_READ = [
  ...CATALOG_REALTIME_READ,
  "recipes:read",
] as const

export function recipeCategoryRealtimeSnapshot(
  row: RecipeCategoryRow,
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    showInMenu: row.showInMenu,
    isActive: row.isActive,
    stationId: row.stationId,
  }
}

export async function publishRecipeCategoryEvent(
  c: Context<SidecarEnv>,
  input: {
    type: CatalogRecipeCategoryEventType
    categoryId: string
    payload?: Record<string, unknown>
  },
): Promise<void> {
  const sidecar = c.get("sidecar")
  await publishDomainEvent(c.env, {
    id: crypto.randomUUID(),
    type: input.type,
    popId: sidecar.popId,
    actorId: c.get("userId"),
    occurredAt: new Date().toISOString(),
    resource: { type: "recipecategory", id: input.categoryId },
    payload: input.payload ?? { categoryId: input.categoryId },
    require: { permissions: [...RECIPE_CATEGORY_REALTIME_READ] },
  })
}

export async function publishRecipeCategoryEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishRecipeCategoryEvent>[1],
): Promise<void> {
  try {
    await publishRecipeCategoryEvent(c, input)
  } catch {
    /* el save no falla si el aviso no sale */
  }
}
