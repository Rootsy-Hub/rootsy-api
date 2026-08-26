import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { CATALOG_REALTIME_READ } from "../../realtime/catalogAcl.js"
import type { ArticleRow } from "./schema.js"

export type CatalogArticleEventType =
  | "articles.created"
  | "articles.updated"
  | "articles.deleted"

export function articleRealtimeSnapshot(
  row: ArticleRow,
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl,
    barcode: row.barcode,
    sku: row.sku,
    itemKind: row.itemKind,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    salePrice: row.salePrice,
    iva: row.iva,
    discountMode: row.discountMode,
    discountValue: row.discountValue,
    unitOfMeasure: row.unitOfMeasure,
    isSellable: row.isSellable,
    isActive: row.isActive,
    allowNegativeStock: row.allowNegativeStock,
    stockOnHand: row.stockOnHand,
    listPrices: row.listPrices,
  }
}

export async function publishArticleEvent(
  c: Context<SidecarEnv>,
  input: {
    type: CatalogArticleEventType
    articleId: string
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
    resource: { type: "article", id: input.articleId },
    payload: input.payload ?? { articleId: input.articleId },
    require: { permissions: [...CATALOG_REALTIME_READ] },
  })
}

export async function publishArticleEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishArticleEvent>[1],
): Promise<void> {
  try {
    await publishArticleEvent(c, input)
  } catch {
    /* el PATCH no falla si el aviso no sale */
  }
}
