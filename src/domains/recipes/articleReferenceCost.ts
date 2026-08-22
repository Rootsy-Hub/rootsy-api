import type { SupabaseClient } from "@supabase/supabase-js"

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

function unitCostInSaleUom(input: {
  unitPrice: number
  saleUnitsPerCostUnit: number
}): number {
  const factor = input.saleUnitsPerCostUnit
  if (!Number.isFinite(factor) || factor <= 0) return 0
  return roundMoney(input.unitPrice / factor)
}

type LayerRow = {
  article_id: string
  unit_cost: number | string
  received_at: string
}

type CatalogCostRow = {
  article_id: string
  unit_price: number | string
  sale_units_per_cost_unit: number | string
  is_active: boolean
  sort_order: number
}

async function fetchLatestLayerUnitCostsByArticleId(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (articleIds.length === 0) return result

  const { data, error } = await supabase
    .from("inventory_cost_layers")
    .select("article_id, unit_cost, received_at")
    .eq("pop_id", popId)
    .in("article_id", articleIds)
    .order("received_at", { ascending: false })

  if (error || !data) return result

  for (const row of data as LayerRow[]) {
    const articleId = String(row.article_id)
    if (result.has(articleId)) continue
    const unitCost = Number(row.unit_cost ?? 0)
    if (Number.isFinite(unitCost) && unitCost > 0) {
      result.set(articleId, roundMoney(unitCost))
    }
  }
  return result
}

async function fetchCatalogReferenceUnitCostsByArticleId(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (articleIds.length === 0) return result

  const { data, error } = await supabase
    .from("article_costs")
    .select("article_id, unit_price, sale_units_per_cost_unit, is_active, sort_order")
    .eq("pop_id", popId)
    .in("article_id", articleIds)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })

  if (error || !data) return result

  for (const row of data as CatalogCostRow[]) {
    const articleId = String(row.article_id)
    if (result.has(articleId)) continue
    const unit = unitCostInSaleUom({
      unitPrice: Number(row.unit_price ?? 0) || 0,
      saleUnitsPerCostUnit: Number(row.sale_units_per_cost_unit ?? 0) || 0,
    })
    if (unit > 0) result.set(articleId, unit)
  }
  return result
}

export async function resolveArticleReferenceUnitCostsByArticleId(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, number>> {
  const uniqueIds = [...new Set(articleIds.filter(Boolean))]
  const fromLayers = await fetchLatestLayerUnitCostsByArticleId(
    supabase,
    popId,
    uniqueIds,
  )
  const missing = uniqueIds.filter((id) => !fromLayers.has(id))
  const fromCatalog =
    missing.length > 0
      ? await fetchCatalogReferenceUnitCostsByArticleId(supabase, popId, missing)
      : new Map<string, number>()

  const merged = new Map<string, number>()
  for (const id of uniqueIds) {
    const value = fromLayers.get(id) ?? fromCatalog.get(id) ?? 0
    if (value > 0) merged.set(id, value)
  }
  return merged
}
