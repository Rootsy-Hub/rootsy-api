import type { SupabaseClient } from "@supabase/supabase-js"
import { operationalDayKey } from "../operations/operationalDay.js"
import { addCalendarDays } from "../operations/timezone.js"
import { roundMoney } from "../reports/money.js"
import {
  fetchArticleCategoriesById,
  fetchRecipeCategoriesById,
  purchaseLineAmount,
  purchaseLineProductKey,
  resolveLineCategory,
  saleLineProductKey,
} from "./catalog.js"
import { buildRankings, buildSegments, compareMetric, dayLabel } from "./compare.js"
import {
  loadSlimPurchases,
  loadSlimSales,
  purchasesTotal,
  salesTotal,
  type SlimPurchase,
  type SlimSale,
} from "./loaders.js"
import {
  emptySection,
  type SectionQuery,
  type StatisticsEvolutionPoint,
  type StatisticsRankRow,
  type StatisticsSectionData,
} from "./schema.js"

function avgSaleTicket(sales: SlimSale[]): number {
  if (sales.length === 0) return 0
  return roundMoney(salesTotal(sales) / sales.length)
}

function avgPurchaseTicket(purchases: SlimPurchase[]): number {
  if (purchases.length === 0) return 0
  return roundMoney(purchasesTotal(purchases) / purchases.length)
}

function dailyAmountPoints(
  metricsByDay: Map<string, { amount: number; count: number }>,
  from: string | null,
  to: string | null,
): StatisticsEvolutionPoint[] {
  const toPoint = (day: string): StatisticsEvolutionPoint => {
    const metrics = metricsByDay.get(day) ?? { amount: 0, count: 0 }
    return {
      label: dayLabel(day),
      value: roundMoney(metrics.amount),
      count: metrics.count,
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

function topRows(
  map: Map<string, { label: string; quantity: number; amount: number }>,
  limit = 10,
): StatisticsRankRow[] {
  return [...map.entries()]
    .sort((a, b) => b[1].quantity - a[1].quantity)
    .slice(0, limit)
    .map(([id, metrics], index) => ({
      rank: index + 1,
      id,
      label: metrics.label,
      value: metrics.quantity,
      secondaryLabel: "Importe",
      secondaryValue: metrics.amount,
      secondaryFormat: "money" as const,
    }))
}

export async function getClientsSummary(
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
      false,
    ),
    query.prevFrom || query.prevTo
      ? loadSlimSales(
          supabase,
          popId,
          popSiteId,
          query.prevFrom,
          query.prevTo,
          query.channel,
          false,
        )
      : Promise.resolve({
          sales: [] as SlimSale[],
          timeZone: "",
          operationalDayCloseTime: "",
        }),
  ])
  const clientIds = new Set<string>()
  const prevClientIds = new Set<string>()
  for (const sale of current.sales) {
    if (sale.clientId) clientIds.add(sale.clientId)
  }
  for (const sale of previous.sales) {
    if (sale.clientId) prevClientIds.add(sale.clientId)
  }
  let newClients = 0
  for (const id of clientIds) {
    if (!prevClientIds.has(id)) newClients += 1
  }
  const recurring = [...clientIds].filter((id) => prevClientIds.has(id)).length
  const data = emptySection(
    "clients",
    "Clientes",
    "Nuevos, recurrentes y facturación por cliente",
  )
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.comparison = [
    compareMetric(
      "clients",
      "Clientes en ventas",
      clientIds.size,
      prevClientIds.size,
      "number",
    ),
    compareMetric("new", "Clientes nuevos", newClients, 0, "number"),
    compareMetric("recurring", "Recurrentes", recurring, 0, "number"),
    compareMetric(
      "ticket",
      "Ticket promedio",
      avgSaleTicket(current.sales),
      avgSaleTicket(previous.sales),
      "money",
    ),
  ]
  return { success: true, data }
}

export async function getClientsDetails(
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
  const clientTotals = new Map<string, number>()
  const trendTotals = new Map<string, { label: string; revenue: number }>()
  const metricsByClientDay = new Map<
    string,
    Map<string, { amount: number; count: number }>
  >()
  const articlesByClient = new Map<
    string,
    Map<string, { label: string; quantity: number; amount: number }>
  >()

  for (const sale of current.sales) {
    const name = sale.customerName?.trim() || "Consumidor final"
    clientTotals.set(name, (clientTotals.get(name) ?? 0) + sale.total)
    if (!sale.clientId) continue
    const prev = trendTotals.get(sale.clientId) ?? {
      label: sale.customerName?.trim() || "Cliente",
      revenue: 0,
    }
    prev.revenue = roundMoney(prev.revenue + sale.total)
    trendTotals.set(sale.clientId, prev)
    const day = operationalDayKey(
      sale.soldAt,
      current.timeZone,
      current.operationalDayCloseTime,
    )
    const dayMap =
      metricsByClientDay.get(sale.clientId) ??
      new Map<string, { amount: number; count: number }>()
    const dayPrev = dayMap.get(day) ?? { amount: 0, count: 0 }
    dayMap.set(day, {
      amount: roundMoney(dayPrev.amount + sale.total),
      count: dayPrev.count + 1,
    })
    metricsByClientDay.set(sale.clientId, dayMap)

    const articleMap =
      articlesByClient.get(sale.clientId) ??
      new Map<string, { label: string; quantity: number; amount: number }>()
    for (const item of sale.lineItems) {
      if (item.quantity <= 0 && item.lineTotal <= 0) continue
      const key = saleLineProductKey(item)
      const label = item.nameSnapshot.trim() || "Sin nombre"
      const articlePrev = articleMap.get(key) ?? { label, quantity: 0, amount: 0 }
      articleMap.set(key, {
        label,
        quantity: roundMoney(articlePrev.quantity + item.quantity),
        amount: roundMoney(articlePrev.amount + item.lineTotal),
      })
    }
    articlesByClient.set(sale.clientId, articleMap)
  }

  const articleIds = [
    ...new Set(
      current.sales.flatMap((sale) =>
        sale.lineItems
          .map((item) => item.articleId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ]
  const recipeIds = [
    ...new Set(
      current.sales.flatMap((sale) =>
        sale.lineItems
          .map((item) => item.recipeId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ]
  const [articleCategories, recipeCategories] = await Promise.all([
    fetchArticleCategoriesById(supabase, popId, articleIds),
    fetchRecipeCategoriesById(supabase, popId, recipeIds),
  ])

  const categoriesByClient = new Map<
    string,
    Map<string, { label: string; quantity: number; amount: number }>
  >()
  for (const sale of current.sales) {
    if (!sale.clientId) continue
    const categoryMap =
      categoriesByClient.get(sale.clientId) ??
      new Map<string, { label: string; quantity: number; amount: number }>()
    for (const item of sale.lineItems) {
      if (item.quantity <= 0 && item.lineTotal <= 0) continue
      const { categoryKey, categoryLabel } = resolveLineCategory(
        item,
        articleCategories,
        recipeCategories,
      )
      const prev = categoryMap.get(categoryKey) ?? {
        label: categoryLabel,
        quantity: 0,
        amount: 0,
      }
      categoryMap.set(categoryKey, {
        label: categoryLabel,
        quantity: roundMoney(prev.quantity + item.quantity),
        amount: roundMoney(prev.amount + item.lineTotal),
      })
    }
    categoriesByClient.set(sale.clientId, categoryMap)
  }

  const clientTrendOptions = [...trendTotals.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([key, { label }]) => ({ key, label }))
  const clientTrendByKey: Record<string, StatisticsEvolutionPoint[]> = {}
  for (const [clientId, dayMap] of metricsByClientDay) {
    clientTrendByKey[clientId] = dailyAmountPoints(dayMap, query.from, query.to)
  }
  const clientTopArticlesByKey: Record<string, StatisticsRankRow[]> = {}
  for (const [clientId, articleMap] of articlesByClient) {
    clientTopArticlesByKey[clientId] = topRows(articleMap)
  }
  const clientTopCategoriesByKey: Record<string, StatisticsRankRow[]> = {}
  for (const [clientId, categoryMap] of categoriesByClient) {
    clientTopCategoriesByKey[clientId] = topRows(categoryMap)
  }

  const data = emptySection(
    "clients",
    "Clientes",
    "Nuevos, recurrentes y facturación por cliente",
  )
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.segments = buildSegments(clientTotals, 6)
  data.rankings = buildRankings(clientTotals)
  data.clientTrendOptions = clientTrendOptions
  data.clientTrendByKey = clientTrendByKey
  data.defaultClientTrendKey = clientTrendOptions[0]?.key ?? null
  data.clientTopArticlesByKey = clientTopArticlesByKey
  data.clientTopCategoriesByKey = clientTopCategoriesByKey
  return { success: true, data }
}

export async function getSuppliersSummary(
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
  const supplierIds = new Set<string>()
  const prevSupplierIds = new Set<string>()
  for (const purchase of current.purchases) {
    if (purchase.supplierId) supplierIds.add(purchase.supplierId)
  }
  for (const purchase of previous.purchases) {
    if (purchase.supplierId) prevSupplierIds.add(purchase.supplierId)
  }
  let newSuppliers = 0
  for (const id of supplierIds) {
    if (!prevSupplierIds.has(id)) newSuppliers += 1
  }
  const recurring = [...supplierIds].filter((id) => prevSupplierIds.has(id)).length
  const data = emptySection(
    "suppliers",
    "Proveedores",
    "Nuevos, recurrentes y compras por proveedor",
  )
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.comparison = [
    compareMetric(
      "suppliers",
      "Proveedores en compras",
      supplierIds.size,
      prevSupplierIds.size,
      "number",
    ),
    compareMetric("new", "Proveedores nuevos", newSuppliers, 0, "number"),
    compareMetric("recurring", "Recurrentes", recurring, 0, "number"),
    compareMetric(
      "ticket",
      "Ticket promedio",
      avgPurchaseTicket(current.purchases),
      avgPurchaseTicket(previous.purchases),
      "money",
    ),
  ]
  return { success: true, data }
}

export async function getSuppliersDetails(
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
  )
  const trendTotals = new Map<string, { label: string; amount: number }>()
  const metricsBySupplierDay = new Map<
    string,
    Map<string, { amount: number; count: number }>
  >()
  const articlesBySupplier = new Map<
    string,
    Map<string, { label: string; quantity: number; amount: number }>
  >()

  for (const purchase of current.purchases) {
    if (!purchase.supplierId) continue
    const prev = trendTotals.get(purchase.supplierId) ?? {
      label: purchase.supplierName?.trim() || "Proveedor",
      amount: 0,
    }
    prev.amount = roundMoney(prev.amount + purchase.total)
    trendTotals.set(purchase.supplierId, prev)
    const day = operationalDayKey(
      purchase.occurredAt,
      current.timeZone,
      current.operationalDayCloseTime,
    )
    const dayMap =
      metricsBySupplierDay.get(purchase.supplierId) ??
      new Map<string, { amount: number; count: number }>()
    const dayPrev = dayMap.get(day) ?? { amount: 0, count: 0 }
    dayMap.set(day, {
      amount: roundMoney(dayPrev.amount + purchase.total),
      count: dayPrev.count + 1,
    })
    metricsBySupplierDay.set(purchase.supplierId, dayMap)

    const articleMap =
      articlesBySupplier.get(purchase.supplierId) ??
      new Map<string, { label: string; quantity: number; amount: number }>()
    for (const line of purchase.lineItems) {
      if (line.quantity <= 0 && purchaseLineAmount(line) <= 0) continue
      const key = purchaseLineProductKey(line)
      const label = line.nameSnapshot.trim() || "Sin nombre"
      const amount = purchaseLineAmount(line)
      const articlePrev = articleMap.get(key) ?? { label, quantity: 0, amount: 0 }
      articleMap.set(key, {
        label,
        quantity: roundMoney(articlePrev.quantity + line.quantity),
        amount: roundMoney(articlePrev.amount + amount),
      })
    }
    articlesBySupplier.set(purchase.supplierId, articleMap)
  }

  const articleIds = [
    ...new Set(
      current.purchases.flatMap((purchase) =>
        purchase.lineItems
          .map((line) => line.articleId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ]
  const articleCategories = await fetchArticleCategoriesById(
    supabase,
    popId,
    articleIds,
  )
  const categoriesBySupplier = new Map<
    string,
    Map<string, { label: string; quantity: number; amount: number }>
  >()
  for (const purchase of current.purchases) {
    if (!purchase.supplierId) continue
    const categoryMap =
      categoriesBySupplier.get(purchase.supplierId) ??
      new Map<string, { label: string; quantity: number; amount: number }>()
    for (const line of purchase.lineItems) {
      if (line.quantity <= 0 && purchaseLineAmount(line) <= 0) continue
      const { categoryKey, categoryLabel } = resolveLineCategory(
        line,
        articleCategories,
        new Map(),
      )
      const amount = purchaseLineAmount(line)
      const prev = categoryMap.get(categoryKey) ?? {
        label: categoryLabel,
        quantity: 0,
        amount: 0,
      }
      categoryMap.set(categoryKey, {
        label: categoryLabel,
        quantity: roundMoney(prev.quantity + line.quantity),
        amount: roundMoney(prev.amount + amount),
      })
    }
    categoriesBySupplier.set(purchase.supplierId, categoryMap)
  }

  const supplierTrendOptions = [...trendTotals.entries()]
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([key, { label }]) => ({ key, label }))
  const supplierTrendByKey: Record<string, StatisticsEvolutionPoint[]> = {}
  for (const [supplierId, dayMap] of metricsBySupplierDay) {
    supplierTrendByKey[supplierId] = dailyAmountPoints(dayMap, query.from, query.to)
  }
  const supplierTopArticlesByKey: Record<string, StatisticsRankRow[]> = {}
  for (const [supplierId, articleMap] of articlesBySupplier) {
    supplierTopArticlesByKey[supplierId] = topRows(articleMap)
  }
  const supplierTopCategoriesByKey: Record<string, StatisticsRankRow[]> = {}
  for (const [supplierId, categoryMap] of categoriesBySupplier) {
    supplierTopCategoriesByKey[supplierId] = topRows(categoryMap)
  }

  const data = emptySection(
    "suppliers",
    "Proveedores",
    "Nuevos, recurrentes y compras por proveedor",
  )
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.supplierTrendOptions = supplierTrendOptions
  data.supplierTrendByKey = supplierTrendByKey
  data.defaultSupplierTrendKey = supplierTrendOptions[0]?.key ?? null
  data.supplierTopArticlesByKey = supplierTopArticlesByKey
  data.supplierTopCategoriesByKey = supplierTopCategoriesByKey
  return { success: true, data }
}
