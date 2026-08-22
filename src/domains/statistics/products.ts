import type { SupabaseClient } from "@supabase/supabase-js"
import { operationalDayKey } from "../operations/operationalDay.js"
import { addCalendarDays } from "../operations/timezone.js"
import { roundMoney } from "../reports/money.js"
import {
  accumulateProductBuckets,
  fetchArticleCategoriesById,
  fetchRecipeCategoriesById,
  hydrateProductBucketCosts,
  resolveBucketCategory,
  resolveLineCategory,
  saleLineProductKey,
  sumProductQuantitiesByKind,
  type ProductStatsBucket,
} from "./catalog.js"
import { compareMetric, dayLabel } from "./compare.js"
import { loadSlimSales } from "./loaders.js"
import {
  emptySection,
  type SectionQuery,
  type StatisticsEvolutionPoint,
  type StatisticsRankRow,
  type StatisticsSectionData,
  type StatisticsSegment,
} from "./schema.js"

function buildProductProfitRankings(
  buckets: Map<string, ProductStatsBucket>,
  limit = 10,
): StatisticsRankRow[] {
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      value: roundMoney(bucket.revenue - bucket.cost),
      quantity: bucket.quantity,
    }))
    .filter((row) => row.value !== 0 || row.quantity > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((row, index) => ({
      rank: index + 1,
      id: row.key,
      label: row.label,
      value: row.value,
      secondaryLabel: "Cantidad",
      secondaryValue: row.quantity,
    }))
}

function buildProductSalesShareRankings(
  buckets: Map<string, ProductStatsBucket>,
  limit = 10,
): StatisticsRankRow[] {
  const totalRevenue = roundMoney(
    [...buckets.values()].reduce((sum, bucket) => sum + bucket.revenue, 0),
  )
  if (totalRevenue <= 0) return []
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      percent: roundMoney((bucket.revenue / totalRevenue) * 100),
      revenue: bucket.revenue,
    }))
    .filter((row) => row.percent > 0)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, limit)
    .map((row, index) => ({
      rank: index + 1,
      id: row.key,
      label: row.label,
      value: row.percent,
      secondaryLabel: "Ventas",
      secondaryValue: row.revenue,
      secondaryFormat: "money" as const,
    }))
}

function buildCategoryTotals(
  buckets: Map<string, ProductStatsBucket>,
  articleCategories: Map<string, { categoryId: string; categoryName: string }>,
  recipeCategories: Map<string, { categoryId: string; categoryName: string }>,
): Map<string, { label: string; revenue: number; cost: number }> {
  const totals = new Map<string, { label: string; revenue: number; cost: number }>()
  for (const bucket of buckets.values()) {
    const { categoryKey, categoryLabel } = resolveBucketCategory(
      bucket,
      articleCategories,
      recipeCategories,
    )
    const prev = totals.get(categoryKey)
    totals.set(categoryKey, {
      label: categoryLabel,
      revenue: roundMoney((prev?.revenue ?? 0) + bucket.revenue),
      cost: roundMoney((prev?.cost ?? 0) + bucket.cost),
    })
  }
  return totals
}

function buildCategorySalesSegments(
  categoryTotals: Map<string, { label: string; revenue: number; cost: number }>,
): StatisticsSegment[] {
  const totalRevenue = roundMoney(
    [...categoryTotals.values()].reduce((sum, row) => sum + row.revenue, 0),
  )
  if (totalRevenue <= 0) return []
  return [...categoryTotals.entries()]
    .filter(([, row]) => row.revenue > 0)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([id, row]) => ({
      id,
      label: row.label,
      value: row.revenue,
      percent: roundMoney((row.revenue / totalRevenue) * 100),
    }))
}

function buildCategoryProfitSegments(
  categoryTotals: Map<string, { label: string; revenue: number; cost: number }>,
): StatisticsSegment[] {
  const rows = [...categoryTotals.entries()]
    .map(([id, row]) => ({
      id,
      label: row.label,
      profit: roundMoney(row.revenue - row.cost),
    }))
    .filter((row) => row.profit > 0)
  const totalProfit = roundMoney(rows.reduce((sum, row) => sum + row.profit, 0))
  if (totalProfit <= 0) return []
  return rows
    .sort((a, b) => b.profit - a.profit)
    .map((row) => ({
      id: row.id,
      label: row.label,
      value: row.profit,
      percent: roundMoney((row.profit / totalProfit) * 100),
    }))
}

function dailyTrendPoints(
  metricsByDay: Map<string, { quantity: number; revenue: number; cost: number }>,
  from: string | null,
  to: string | null,
): StatisticsEvolutionPoint[] {
  const toPoint = (day: string): StatisticsEvolutionPoint => {
    const metrics = metricsByDay.get(day) ?? { quantity: 0, revenue: 0, cost: 0 }
    const revenue = roundMoney(metrics.revenue)
    const cost = roundMoney(metrics.cost)
    return {
      label: dayLabel(day),
      value: revenue,
      count: roundMoney(metrics.quantity),
      profit: roundMoney(revenue - cost),
    }
  }
  if (!from || !to) {
    return [...metricsByDay.keys()].sort().map(toPoint)
  }
  const points: StatisticsEvolutionPoint[] = []
  let cursor = from
  while (cursor <= to) {
    points.push(toPoint(cursor))
    cursor = addCalendarDays(cursor, 1)
  }
  return points
}

export async function getProductsSummary(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const [current, previous] = await Promise.all([
    loadSlimSales(
      supabase,
      popId,
      popSiteId,
      query.from,
      query.to,
      query.channel,
      true,
    ),
    query.prevFrom || query.prevTo
      ? loadSlimSales(
          supabase,
          popId,
          popSiteId,
          query.prevFrom,
          query.prevTo,
          query.channel,
          true,
        )
      : Promise.resolve({
          sales: [],
          timeZone: "",
          operationalDayCloseTime: "",
        }),
  ])
  const currentCounts = sumProductQuantitiesByKind(current.sales)
  const prevCounts = sumProductQuantitiesByKind(previous.sales)
  const data = emptySection(
    "products",
    "Productos",
    "Rentabilidad y participación por producto y categoría",
  )
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.comparison = [
    compareMetric(
      "articles",
      "Artículos vendidos",
      currentCounts.articles,
      prevCounts.articles,
      "number",
    ),
    compareMetric(
      "promotions",
      "Promociones vendidas",
      currentCounts.promotions,
      prevCounts.promotions,
      "number",
    ),
    compareMetric(
      "recipes",
      "Recetas vendidas",
      currentCounts.recipes,
      prevCounts.recipes,
      "number",
    ),
  ]
  return { success: true, data }
}

export async function getProductsDetails(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const current = await loadSlimSales(
    supabase,
    popId,
    popSiteId,
    query.from,
    query.to,
    query.channel,
    true,
  )
  const buckets = new Map<string, ProductStatsBucket>()
  accumulateProductBuckets(current.sales, buckets)
  await hydrateProductBucketCosts(supabase, popId, buckets)

  const articleIds = [
    ...new Set(
      [...buckets.values()]
        .map((bucket) => bucket.articleId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const recipeIds = [
    ...new Set(
      [...buckets.values()]
        .map((bucket) => bucket.recipeId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const [articleCategories, recipeCategories] = await Promise.all([
    fetchArticleCategoriesById(supabase, popId, articleIds),
    fetchRecipeCategoriesById(supabase, popId, recipeIds),
  ])
  const categoryTotals = buildCategoryTotals(
    buckets,
    articleCategories,
    recipeCategories,
  )

  const costRatioByKey = new Map<string, number>()
  for (const [key, bucket] of buckets) {
    costRatioByKey.set(key, bucket.revenue > 0 ? bucket.cost / bucket.revenue : 0)
  }

  const metricsByProductDay = new Map<
    string,
    Map<string, { quantity: number; revenue: number; cost: number }>
  >()
  const metricsByCategoryDay = new Map<
    string,
    Map<string, { quantity: number; revenue: number; cost: number }>
  >()
  for (const sale of current.sales) {
    const day = operationalDayKey(
      sale.soldAt,
      current.timeZone,
      current.operationalDayCloseTime,
    )
    for (const item of sale.lineItems) {
      if (item.lineTotal <= 0 && item.quantity <= 0) continue
      const productKey = saleLineProductKey(item)
      const { categoryKey } = resolveLineCategory(
        item,
        articleCategories,
        recipeCategories,
      )
      const lineRevenue = roundMoney(item.lineTotal)
      const lineCost = roundMoney(lineRevenue * (costRatioByKey.get(productKey) ?? 0))
      const bump = (
        map: Map<string, Map<string, { quantity: number; revenue: number; cost: number }>>,
        key: string,
      ) => {
        const dayMap =
          map.get(key) ??
          new Map<string, { quantity: number; revenue: number; cost: number }>()
        const prev = dayMap.get(day) ?? { quantity: 0, revenue: 0, cost: 0 }
        dayMap.set(day, {
          quantity: roundMoney(prev.quantity + item.quantity),
          revenue: roundMoney(prev.revenue + lineRevenue),
          cost: roundMoney(prev.cost + lineCost),
        })
        map.set(key, dayMap)
      }
      bump(metricsByProductDay, productKey)
      bump(metricsByCategoryDay, categoryKey)
    }
  }

  const productTrendByKey: Record<string, StatisticsEvolutionPoint[]> = {}
  for (const [key, dayMap] of metricsByProductDay) {
    productTrendByKey[key] = dailyTrendPoints(dayMap, query.from, query.to)
  }
  const categoryTrendByKey: Record<string, StatisticsEvolutionPoint[]> = {}
  for (const [key, dayMap] of metricsByCategoryDay) {
    categoryTrendByKey[key] = dailyTrendPoints(dayMap, query.from, query.to)
  }

  const productTrendOptions = [...buckets.entries()]
    .map(([key, bucket]) => ({ key, label: bucket.label }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"))
  const categoryTrendOptions = [...categoryTotals.entries()]
    .filter(([, row]) => row.revenue > 0)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([key, row]) => ({ key, label: row.label }))
  const profitRankings = buildProductProfitRankings(buckets)

  const data = emptySection(
    "products",
    "Productos",
    "Rentabilidad y participación por producto y categoría",
  )
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.rankings = profitRankings
  data.productSalesRankings = buildProductSalesShareRankings(buckets)
  data.productTrendOptions = productTrendOptions
  data.productTrendByKey = productTrendByKey
  data.defaultProductTrendKey = profitRankings[0]?.id ?? null
  data.categoryProfitDistribution = buildCategoryProfitSegments(categoryTotals)
  data.categorySalesDistribution = buildCategorySalesSegments(categoryTotals)
  data.categoryTrendOptions = categoryTrendOptions
  data.categoryTrendByKey = categoryTrendByKey
  data.defaultCategoryTrendKey = categoryTrendOptions[0]?.key ?? null
  return { success: true, data }
}
