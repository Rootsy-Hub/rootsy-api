import type { SupabaseClient } from "@supabase/supabase-js"
import type { ArticleItemKind } from "../articles/schema.js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { addCalendarDays } from "../operations/timezone.js"
import { isArticleItemKind, STOCK_KIND_LABELS } from "./catalog.js"
import { compareMetric, dayLabel } from "./compare.js"
import {
  emptySection,
  type SectionQuery,
  type StatisticsEvolutionPoint,
  type StatisticsSectionData,
  type StatisticsSegment,
  type StatisticsSunburstNode,
} from "./schema.js"

const OVERSTOCK_MULTIPLIER = 2
const SUNBURST_MAX_ARTICLES = 8

type Snapshot = {
  articleId: string
  name: string
  quantity: number
  minLevel: number | null
  inventoryValue: number
  stockLevel: "below_min" | "optimal" | "overstock" | "out_of_stock"
  itemKind: ArticleItemKind
  categoryId: string
  categoryName: string
}

function classifyStock(
  quantity: number,
  minLevel: number | null,
): Snapshot["stockLevel"] {
  if (quantity <= 0) return "out_of_stock"
  if (minLevel == null || minLevel <= 0) return "optimal"
  if (quantity < minLevel) return "below_min"
  if (quantity > minLevel * OVERSTOCK_MULTIPLIER) return "overstock"
  return "optimal"
}

function snapshotMetrics(snapshots: Snapshot[]) {
  let inventoryValue = 0
  let unitsInStock = 0
  let lowStockArticles = 0
  let outOfStockArticles = 0
  for (const snapshot of snapshots) {
    if (snapshot.stockLevel === "out_of_stock") {
      outOfStockArticles += 1
      continue
    }
    unitsInStock = roundMoney(unitsInStock + snapshot.quantity)
    inventoryValue = roundMoney(inventoryValue + snapshot.inventoryValue)
    if (snapshot.stockLevel === "below_min") lowStockArticles += 1
  }
  return { inventoryValue, unitsInStock, lowStockArticles, outOfStockArticles }
}

async function loadCurrentOnHand(
  supabase: SupabaseClient,
  popId: string,
): Promise<Map<string, number>> {
  const qty = new Map<string, number>()
  const { data } = await supabase
    .from("inventory_on_hand")
    .select("article_id, quantity")
    .eq("pop_id", popId)
  for (const row of data || []) {
    const articleId = String(row.article_id)
    qty.set(articleId, (qty.get(articleId) ?? 0) + parseMoney(row.quantity))
  }
  return qty
}

async function loadDeltasAfter(
  supabase: SupabaseClient,
  popId: string,
  afterDate: string,
): Promise<Map<string, number>> {
  const deltas = new Map<string, number>()
  let from = 0
  const page = 1000
  while (from < 50_000) {
    const { data } = await supabase
      .from("inventory_movements")
      .select("article_id, quantity_delta, created_at")
      .eq("pop_id", popId)
      .gt("created_at", `${afterDate}T23:59:59.999`)
      .range(from, from + page - 1)
    const rows = data || []
    for (const row of rows) {
      const articleId = String(row.article_id)
      deltas.set(
        articleId,
        (deltas.get(articleId) ?? 0) + Number(row.quantity_delta ?? 0),
      )
    }
    if (rows.length < page) break
    from += page
  }
  return deltas
}

function qtyAsOf(
  current: Map<string, number>,
  laterDeltas: Map<string, number> | null,
  articleId: string,
): number {
  const live = current.get(articleId) ?? 0
  if (!laterDeltas) return live
  return live - (laterDeltas.get(articleId) ?? 0)
}

async function buildSnapshots(
  supabase: SupabaseClient,
  popId: string,
  currentOnHand: Map<string, number>,
  laterDeltas: Map<string, number> | null,
): Promise<Snapshot[]> {
  const { data: articles } = await supabase
    .from("articles")
    .select(
      "id, name, min_stock_level, track_stock, item_kind, category_id, categories(name)",
    )
    .eq("pop_id", popId)
    .eq("is_active", true)
  const tracked = (articles || []).filter((article) => article.track_stock)
  if (tracked.length === 0) return []
  const articleIds = tracked.map((article) => String(article.id))
  const unitCosts = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    articleIds,
  )
  return tracked.map((article) => {
    const articleId = String(article.id)
    const quantity =
      Math.round(qtyAsOf(currentOnHand, laterDeltas, articleId) * 1e6) / 1e6
    const minLevel =
      article.min_stock_level != null ? Number(article.min_stock_level) : null
    const unitCost = unitCosts.get(articleId) ?? 0
    const rawKind = String(article.item_kind ?? "merchandise")
    const itemKind: ArticleItemKind = isArticleItemKind(rawKind)
      ? rawKind
      : "merchandise"
    const category = article.categories as { name?: string } | null
    return {
      articleId,
      name: String(article.name ?? "").trim() || "Artículo",
      quantity,
      minLevel,
      inventoryValue: roundMoney(Math.max(0, quantity) * unitCost),
      stockLevel: classifyStock(quantity, minLevel),
      itemKind,
      categoryId: String(article.category_id ?? "sin-categoria"),
      categoryName: category?.name?.trim() || "Sin categoría",
    }
  })
}

function stockLevelDistribution(snapshots: Snapshot[]): StatisticsSegment[] {
  const counts = { below_min: 0, optimal: 0, overstock: 0 }
  for (const snapshot of snapshots) {
    if (snapshot.stockLevel === "out_of_stock") continue
    counts[snapshot.stockLevel] += 1
  }
  const total = counts.below_min + counts.optimal + counts.overstock
  if (total <= 0) return []
  return [
    {
      id: "below_min",
      label: "Bajo mínimo",
      value: counts.below_min,
      percent: roundMoney((counts.below_min / total) * 100),
    },
    {
      id: "optimal",
      label: "Óptimo",
      value: counts.optimal,
      percent: roundMoney((counts.optimal / total) * 100),
    },
    {
      id: "overstock",
      label: "Sobre-stock",
      value: counts.overstock,
      percent: roundMoney((counts.overstock / total) * 100),
    },
  ].filter((segment) => segment.value > 0)
}

function inventoryValueSunburst(snapshots: Snapshot[]): StatisticsSunburstNode | null {
  const valued = snapshots.filter((snapshot) => snapshot.inventoryValue > 0)
  if (valued.length === 0) return null
  type CategoryBucket = {
    categoryId: string
    label: string
    articles: Snapshot[]
  }
  const byKind = new Map<
    ArticleItemKind,
    { label: string; categories: Map<string, CategoryBucket> }
  >()
  for (const snapshot of valued) {
    const kindBucket = byKind.get(snapshot.itemKind) ?? {
      label: STOCK_KIND_LABELS[snapshot.itemKind],
      categories: new Map<string, CategoryBucket>(),
    }
    const categoryBucket = kindBucket.categories.get(snapshot.categoryId) ?? {
      categoryId: snapshot.categoryId,
      label: snapshot.categoryName,
      articles: [],
    }
    categoryBucket.articles.push(snapshot)
    kindBucket.categories.set(snapshot.categoryId, categoryBucket)
    byKind.set(snapshot.itemKind, kindBucket)
  }
  const kindNodes: StatisticsSunburstNode[] = [...byKind.entries()]
    .map(([itemKind, kindBucket]) => {
      const categoryNodes = [...kindBucket.categories.values()]
        .map((category) => {
          const articleNodes = category.articles
            .sort((a, b) => b.inventoryValue - a.inventoryValue)
            .slice(0, SUNBURST_MAX_ARTICLES)
            .map((article) => ({
              id: `article:${article.articleId}`,
              label: article.name,
              value: article.inventoryValue,
            }))
          return {
            id: `category:${itemKind}:${category.categoryId}`,
            label: category.label,
            value: roundMoney(articleNodes.reduce((sum, node) => sum + node.value, 0)),
            children: articleNodes,
          }
        })
        .filter((node) => node.value > 0)
        .sort((a, b) => b.value - a.value)
      return {
        id: `kind:${itemKind}`,
        label: kindBucket.label,
        value: roundMoney(categoryNodes.reduce((sum, node) => sum + node.value, 0)),
        children: categoryNodes,
      }
    })
    .filter((node) => node.value > 0)
    .sort((a, b) => b.value - a.value)
  const total = roundMoney(kindNodes.reduce((sum, node) => sum + node.value, 0))
  if (total <= 0) return null
  return {
    id: "inventory-total",
    label: "Inventario",
    value: total,
    children: kindNodes,
  }
}

async function movementEvolution(
  supabase: SupabaseClient,
  popId: string,
  from: string | null,
  to: string | null,
): Promise<StatisticsEvolutionPoint[]> {
  const metricsByDay = new Map<string, { ingresos: number; egresos: number }>()
  let start = 0
  const page = 1000
  while (start < 50_000) {
    let q = supabase
      .from("inventory_movements")
      .select("quantity_delta, created_at")
      .eq("pop_id", popId)
      .range(start, start + page - 1)
    if (from) q = q.gte("created_at", `${from}T00:00:00`)
    if (to) q = q.lte("created_at", `${to}T23:59:59.999`)
    const { data } = await q
    const rows = data || []
    for (const row of rows) {
      const day = String(row.created_at ?? "").slice(0, 10)
      if (from && day < from) continue
      if (to && day > to) continue
      const delta = Number(row.quantity_delta ?? 0)
      if (delta === 0) continue
      const prev = metricsByDay.get(day) ?? { ingresos: 0, egresos: 0 }
      if (delta > 0) prev.ingresos = roundMoney(prev.ingresos + delta)
      else prev.egresos = roundMoney(prev.egresos + Math.abs(delta))
      metricsByDay.set(day, prev)
    }
    if (rows.length < page) break
    start += page
  }

  const toPoint = (day: string): StatisticsEvolutionPoint => {
    const metrics = metricsByDay.get(day) ?? { ingresos: 0, egresos: 0 }
    return {
      label: dayLabel(day),
      value: roundMoney(metrics.ingresos),
      count: roundMoney(metrics.egresos),
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

function todayIso(): string {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
}

export async function getInventorySummary(
  supabase: SupabaseClient,
  popId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const currentOnHand = await loadCurrentOnHand(supabase, popId)
  const asOf = query.to && query.to < todayIso() ? query.to : null
  const prevAsOf = query.prevTo && query.prevTo < todayIso() ? query.prevTo : null
  const [currentDeltas, previousDeltas] = await Promise.all([
    asOf ? loadDeltasAfter(supabase, popId, asOf) : Promise.resolve(null),
    prevAsOf ? loadDeltasAfter(supabase, popId, prevAsOf) : Promise.resolve(null),
  ])
  const [currentSnapshots, previousSnapshots] = await Promise.all([
    buildSnapshots(supabase, popId, currentOnHand, currentDeltas),
    prevAsOf
      ? buildSnapshots(supabase, popId, currentOnHand, previousDeltas)
      : Promise.resolve([] as Snapshot[]),
  ])
  const current = snapshotMetrics(currentSnapshots)
  const previous = snapshotMetrics(previousSnapshots)
  const data = emptySection(
    "inventory",
    "Inventario",
    "Stock actual, alertas y concentración por artículo",
  )
  data.comparison = [
    compareMetric(
      "value",
      "Valor del inventario",
      current.inventoryValue,
      previous.inventoryValue,
      "money",
    ),
    compareMetric(
      "units",
      "Unidades en stock",
      current.unitsInStock,
      previous.unitsInStock,
      "number",
    ),
    compareMetric(
      "low",
      "Artículos con stock bajo",
      current.lowStockArticles,
      previous.lowStockArticles,
      "number",
    ),
    compareMetric(
      "empty",
      "Artículos sin stock",
      current.outOfStockArticles,
      previous.outOfStockArticles,
      "number",
    ),
  ]
  return { success: true, data }
}

export async function getInventoryDetails(
  supabase: SupabaseClient,
  popId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const currentOnHand = await loadCurrentOnHand(supabase, popId)
  const asOf = query.to && query.to < todayIso() ? query.to : null
  const laterDeltas = asOf ? await loadDeltasAfter(supabase, popId, asOf) : null
  const [snapshots, evolution] = await Promise.all([
    buildSnapshots(supabase, popId, currentOnHand, laterDeltas),
    movementEvolution(supabase, popId, query.from, query.to),
  ])
  const data = emptySection(
    "inventory",
    "Inventario",
    "Stock actual, alertas y concentración por artículo",
  )
  data.evolution = evolution
  data.stockLevelDistribution = stockLevelDistribution(snapshots)
  data.inventoryValueSunburst = inventoryValueSunburst(snapshots)
  return { success: true, data }
}
