export const PROMOTION_TYPES = ["combo", "quantity_deal"] as const
export const PROMOTION_PRICING_MODES = [
  "fixed_total",
  "percent_off",
  "fixed_off",
] as const
export const PROMOTION_BENEFIT_TARGETS = ["cheapest", "most_expensive"] as const
export const ALL_PROMOTION_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

export type PromotionType = (typeof PROMOTION_TYPES)[number]
export type PromotionPricingMode = (typeof PROMOTION_PRICING_MODES)[number]
export type PromotionDiscountMode = "porcentaje" | "fijo"
export type PromotionBenefitTarget = (typeof PROMOTION_BENEFIT_TARGETS)[number]
export type PromotionOptionKind = "article" | "recipe"

export const PROMOTION_BENEFIT_TARGET_LABEL: Record<
  PromotionBenefitTarget,
  string
> = {
  cheapest: "El más barato",
  most_expensive: "El más caro",
}

export function isPromotionType(v: string): v is PromotionType {
  return (PROMOTION_TYPES as readonly string[]).includes(v)
}

export function isPromotionPricingMode(v: string): v is PromotionPricingMode {
  return (PROMOTION_PRICING_MODES as readonly string[]).includes(v)
}

export function isPromotionBenefitTarget(v: string): v is PromotionBenefitTarget {
  return (PROMOTION_BENEFIT_TARGETS as readonly string[]).includes(v)
}

export function isPromotionOptionKind(v: string): v is PromotionOptionKind {
  return v === "article" || v === "recipe"
}

export function promotionPricingSummary(input: {
  promotionType: PromotionType
  pricingMode: PromotionPricingMode
  fixedPrice: number | null
  discountMode: PromotionDiscountMode | null
  discountValue: number | null
  buyQuantity: number | null
  benefitQuantity: number | null
  benefitDiscountPct: number | null
  applyBenefitTo: PromotionBenefitTarget | null
}): string {
  if (input.promotionType === "quantity_deal") {
    const buy = input.buyQuantity ?? 0
    const benefit = input.benefitQuantity ?? 0
    const pct = input.benefitDiscountPct ?? 0
    const target = input.applyBenefitTo
      ? PROMOTION_BENEFIT_TARGET_LABEL[input.applyBenefitTo]
      : "—"
    if (pct >= 100) {
      return `${buy}x${buy - benefit} (${target.toLowerCase()})`
    }
    return `${buy}+${benefit} al ${pct}% (${target.toLowerCase()})`
  }
  if (input.pricingMode === "fixed_total") {
    return `Precio fijo $${(input.fixedPrice ?? 0).toLocaleString("es-AR")}`
  }
  if (input.pricingMode === "percent_off") {
    return `${input.discountValue ?? 0}% off por ítem`
  }
  return `$${(input.discountValue ?? 0).toLocaleString("es-AR")} off por ítem`
}
