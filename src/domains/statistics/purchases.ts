import type { SupabaseClient } from "@supabase/supabase-js"
import { ARTICLE_ITEM_KINDS } from "../articles/schema.js"
import { roundMoney } from "../reports/money.js"
import {
  COST_KIND_LABELS,
  fetchArticleItemKindsById,
  purchaseLineAmount,
} from "./catalog.js"
import { buildRankings, buildSegments, compareMetric } from "./compare.js"
import { loadSlimPurchases, purchasesTotal, type SlimPurchase } from "./loaders.js"
import { emptySection, type SectionQuery, type StatisticsSectionData } from "./schema.js"
import { buildDailyPurchaseEvolution } from "./series.js"

function avgTicket(purchases: SlimPurchase[]): number {
  if (purchases.length === 0) return 0
  return roundMoney(purchasesTotal(purchases) / purchases.length)
}

export async function getPurchasesSummary(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const [current, previous] = await Promise.all([
    loadSlimPurchases(
      supabase,
      popId,
      popSiteId,
      query.from,
      query.to,
      query.supplier,
      false,
    ),
    query.prevFrom || query.prevTo
      ? loadSlimPurchases(
          supabase,
          popId,
          popSiteId,
          query.prevFrom,
          query.prevTo,
          query.supplier,
          false,
        )
      : Promise.resolve({
          purchases: [] as SlimPurchase[],
          timeZone: "",
          operationalDayCloseTime: "",
        }),
  ])
  const data = emptySection("purchases", "Compras", "Evolución e importes del período")
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.comparison = [
    compareMetric(
      "total",
      "Compras",
      purchasesTotal(current.purchases),
      purchasesTotal(previous.purchases),
      "money",
    ),
    compareMetric(
      "count",
      "Cantidad",
      current.purchases.length,
      previous.purchases.length,
      "number",
    ),
    compareMetric(
      "ticket",
      "Ticket promedio",
      avgTicket(current.purchases),
      avgTicket(previous.purchases),
      "money",
    ),
  ]
  return { success: true, data }
}

export async function getPurchasesDetails(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const current = await loadSlimPurchases(
    supabase,
    popId,
    popSiteId,
    query.from,
    query.to,
    query.supplier,
    true,
    true,
  )
  const buyerTotals = new Map<string, number>()
  const buyerCounts = new Map<string, number>()
  const kindTotals = new Map<string, number>(
    ARTICLE_ITEM_KINDS.map((kind) => [kind, 0]),
  )
  const articleIds = [
    ...new Set(
      current.purchases.flatMap((purchase) =>
        purchase.lineItems
          .map((line) => line.articleId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ]
  const articleKindById = await fetchArticleItemKindsById(
    supabase,
    popId,
    articleIds,
  )

  for (const purchase of current.purchases) {
    const name = purchase.purchasedByName?.trim() || "Sin comprador"
    buyerTotals.set(name, (buyerTotals.get(name) ?? 0) + purchase.total)
    buyerCounts.set(name, (buyerCounts.get(name) ?? 0) + 1)
    for (const line of purchase.lineItems) {
      if (!line.articleId) continue
      const kind = articleKindById.get(line.articleId)
      if (!kind) continue
      kindTotals.set(kind, (kindTotals.get(kind) ?? 0) + purchaseLineAmount(line))
    }
  }

  const grand = [...kindTotals.values()].reduce((sum, value) => sum + value, 0)
  const purchaseDistribution =
    grand > 0
      ? ARTICLE_ITEM_KINDS.map((kind) => {
          const value = roundMoney(kindTotals.get(kind) ?? 0)
          return {
            label: COST_KIND_LABELS[kind],
            value,
            percent: roundMoney((value / grand) * 100),
          }
        }).filter((row) => row.value > 0)
      : []

  const data = emptySection("purchases", "Compras", "Evolución e importes del período")
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.evolution = buildDailyPurchaseEvolution(
    current.purchases,
    query.from,
    query.to,
    current.timeZone,
    current.operationalDayCloseTime,
  )
  data.segments = buildSegments(buyerTotals, 6)
  data.rankings = buildRankings(buyerTotals, buyerCounts)
  data.purchaseDistribution = purchaseDistribution
  return { success: true, data }
}
