import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { CATALOG_REALTIME_READ } from "../../realtime/catalogAcl.js"
import type { CategoryRow } from "./schema.js"

export type CatalogCategoryEventType =
  | "categories.created"
  | "categories.updated"
  | "categories.deleted"

export function categoryRealtimePayload(
  row: Pick<
    CategoryRow,
    "id" | "name" | "itemKind" | "sortOrder" | "showInSale"
  > &
    Partial<Pick<CategoryRow, "visible" | "showInMenu">>,
): Record<string, unknown> {
  return {
    category: {
      id: row.id,
      name: row.name,
      itemKind: row.itemKind,
      sortOrder: row.sortOrder,
      showInSale: row.showInSale,
      visible: row.visible,
      showInMenu: row.showInMenu,
    },
  }
}

export async function publishCategoryEvent(
  c: Context<SidecarEnv>,
  input: {
    type: CatalogCategoryEventType
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
    resource: { type: "category", id: input.categoryId },
    payload: input.payload ?? { categoryId: input.categoryId },
    require: { permissions: [...CATALOG_REALTIME_READ] },
  })
}
