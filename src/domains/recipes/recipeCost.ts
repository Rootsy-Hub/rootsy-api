export type RecipeCostIngredientInput = {
  quantity: number
  wastePct: number | null
  articleCostPrice: number
  articleDefaultWastePct: number | null
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export function effectiveWastePct(
  lineWastePct: number | null | undefined,
  articleDefaultWastePct: number | null | undefined,
): number {
  if (lineWastePct != null && Number.isFinite(lineWastePct)) {
    return Math.max(0, Math.min(100, lineWastePct))
  }
  if (articleDefaultWastePct != null && Number.isFinite(articleDefaultWastePct)) {
    return Math.max(0, Math.min(100, articleDefaultWastePct))
  }
  return 0
}

export function ingredientLineCost(input: RecipeCostIngredientInput): number {
  const qty = Number(input.quantity)
  const cost = Number(input.articleCostPrice)
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost < 0) {
    return 0
  }
  const waste = effectiveWastePct(input.wastePct, input.articleDefaultWastePct)
  return roundMoney(qty * cost * (1 + waste / 100))
}

export function computeRecipeCostPrice(
  ingredients: RecipeCostIngredientInput[],
): number {
  return roundMoney(
    ingredients.reduce((sum, line) => sum + ingredientLineCost(line), 0),
  )
}
