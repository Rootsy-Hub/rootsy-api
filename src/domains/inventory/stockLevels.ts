export const INVENTORY_OVERSTOCK_MULTIPLIER = 2
export const INVENTORY_RECOMMENDATION_LOOKBACK_DAYS = 28
export const INVENTORY_RECOMMENDATION_COVER_DAYS = 7

export type InventoryAttention =
  | "negative"
  | "empty"
  | "below_min"
  | "overstock"
  | "ok"

export function classifyInventoryAttention(
  quantity: number,
  minLevel: number | null,
): InventoryAttention {
  if (quantity < -1e-6) return "negative"
  if (Math.abs(quantity) < 1e-6) return "empty"
  if (minLevel != null && minLevel > 0 && quantity < minLevel - 1e-6) {
    return "below_min"
  }
  if (
    minLevel != null &&
    minLevel > 0 &&
    quantity > minLevel * INVENTORY_OVERSTOCK_MULTIPLIER + 1e-6
  ) {
    return "overstock"
  }
  return "ok"
}

export function recommendMinFromDailyOutflow(
  avgDailyOutflow: number,
  currentMin: number | null,
  quantity: number,
): number | null {
  const fromVelocity =
    avgDailyOutflow > 1e-6
      ? Math.max(
          1,
          Math.ceil(avgDailyOutflow * INVENTORY_RECOMMENDATION_COVER_DAYS),
        )
      : null

  if (fromVelocity != null) {
    if (currentMin != null && Math.abs(fromVelocity - currentMin) < 1e-6) {
      return null
    }
    return fromVelocity
  }

  if ((currentMin == null || currentMin <= 0) && quantity <= 1e-6) {
    return 1
  }

  return null
}

export function suggestedMaxFromMin(minLevel: number | null): number | null {
  if (minLevel == null || minLevel <= 0) return null
  return Math.ceil(minLevel * INVENTORY_OVERSTOCK_MULTIPLIER)
}

export function suggestedPurchaseQty(
  quantity: number,
  minLevel: number | null,
  suggestedMin: number | null,
): number {
  const target =
    minLevel != null && minLevel > 0
      ? minLevel
      : suggestedMin != null && suggestedMin > 0
        ? suggestedMin
        : 0
  if (target <= 0) {
    return quantity <= 1e-6 ? 1 : 0
  }
  return Math.max(0, Math.ceil(target - quantity))
}
