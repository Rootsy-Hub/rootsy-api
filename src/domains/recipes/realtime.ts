import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { CATALOG_REALTIME_READ } from "../../realtime/catalogAcl.js"
import type { RecipeRow } from "./schema.js"

export type CatalogRecipeEventType =
  | "recipes.created"
  | "recipes.updated"
  | "recipes.deleted"

const RECIPE_REALTIME_READ = [
  ...CATALOG_REALTIME_READ,
  "recipes:read",
] as const

export function recipeRealtimeSnapshot(
  row: RecipeRow,
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    salePrice: row.salePrice,
    iva: row.iva,
    isActive: row.isActive,
    allowNegativeStock: row.allowNegativeStock,
    stationId: row.stationId,
    listPrices: row.listPrices,
  }
}

export async function publishRecipeEvent(
  c: Context<SidecarEnv>,
  input: {
    type: CatalogRecipeEventType
    recipeId: string
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
    resource: { type: "recipe", id: input.recipeId },
    payload: input.payload ?? { recipeId: input.recipeId },
    require: { permissions: [...RECIPE_REALTIME_READ] },
  })
}

export async function publishRecipeEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishRecipeEvent>[1],
): Promise<void> {
  try {
    await publishRecipeEvent(c, input)
  } catch {
    /* el save no falla si el aviso no sale */
  }
}
