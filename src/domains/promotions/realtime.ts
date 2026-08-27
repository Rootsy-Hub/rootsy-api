import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { CATALOG_REALTIME_READ } from "../../realtime/catalogAcl.js"
import type { PromotionDetail } from "./schema.js"

export type CatalogPromotionEventType =
  | "promotions.created"
  | "promotions.updated"
  | "promotions.deleted"

const PROMOTION_REALTIME_READ = [
  ...CATALOG_REALTIME_READ,
  "promotions:read",
] as const

export function promotionRealtimeSnapshot(
  row: PromotionDetail,
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl,
    promotionType: row.promotionType,
    pricingMode: row.pricingMode,
    fixedPrice: row.fixedPrice,
    discountMode: row.discountMode,
    discountValue: row.discountValue,
    buyQuantity: row.buyQuantity,
    benefitQuantity: row.benefitQuantity,
    benefitDiscountPct: row.benefitDiscountPct,
    applyBenefitTo: row.applyBenefitTo,
    autoApply: row.autoApply,
    showInMenu: row.showInMenu,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    validTimeStart: row.validTimeStart,
    validTimeEnd: row.validTimeEnd,
    scheduleDays: row.scheduleDays,
    slots: row.slots,
  }
}

export async function publishPromotionEvent(
  c: Context<SidecarEnv>,
  input: {
    type: CatalogPromotionEventType
    promotionId: string
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
    resource: { type: "promotion", id: input.promotionId },
    payload: input.payload ?? { promotionId: input.promotionId },
    require: { permissions: [...PROMOTION_REALTIME_READ] },
  })
}

export async function publishPromotionEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishPromotionEvent>[1],
): Promise<void> {
  try {
    await publishPromotionEvent(c, input)
  } catch {
    /* el PATCH no falla si el aviso no sale */
  }
}
