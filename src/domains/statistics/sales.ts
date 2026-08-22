import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildRankings,
  buildSegments,
  compareMetric,
  saleChannelLabel,
} from "./compare.js"
import { loadSlimSales, salesTotal, type SlimSale } from "./loaders.js"
import { emptySection, type SectionQuery, type StatisticsSectionData } from "./schema.js"
import { buildDailySaleEvolution, buildHourlySalesViews } from "./series.js"

function avgTicket(sales: SlimSale[]): number {
  if (sales.length === 0) return 0
  return Math.round((salesTotal(sales) / sales.length) * 100) / 100
}

export async function getSalesSummary(
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
      : Promise.resolve({ sales: [] as SlimSale[], timeZone: "", operationalDayCloseTime: "" }),
  ])

  const total = salesTotal(current.sales)
  const prevTotal = salesTotal(previous.sales)
  const data = emptySection("sales", "Ventas")
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.comparison = [
    compareMetric("total", "Ventas", total, prevTotal, "money"),
    compareMetric(
      "count",
      "Cantidad",
      current.sales.length,
      previous.sales.length,
      "number",
    ),
    compareMetric(
      "ticket",
      "Ticket promedio",
      avgTicket(current.sales),
      avgTicket(previous.sales),
      "money",
    ),
  ]
  return { success: true, data }
}

export async function getSalesDetails(
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
    false,
    true,
  )
  const channelTotals = new Map<string, number>()
  const sellerTotals = new Map<string, number>()
  const sellerCounts = new Map<string, number>()
  for (const sale of current.sales) {
    const channel = saleChannelLabel(sale.saleChannel)
    channelTotals.set(channel, (channelTotals.get(channel) ?? 0) + sale.total)
    const seller = sale.soldByName?.trim() || "Sin vendedor"
    sellerTotals.set(seller, (sellerTotals.get(seller) ?? 0) + sale.total)
    sellerCounts.set(seller, (sellerCounts.get(seller) ?? 0) + 1)
  }

  const data = emptySection("sales", "Ventas")
  data.operationalDayCloseTime = current.operationalDayCloseTime
  data.evolution = buildDailySaleEvolution(
    current.sales,
    query.from,
    query.to,
    current.timeZone,
    current.operationalDayCloseTime,
  )
  const hourly = buildHourlySalesViews(
    current.sales,
    query.from,
    query.to,
    current.timeZone,
    current.operationalDayCloseTime,
  )
  data.hourlyEvolution = hourly.hourlyEvolution
  data.hourlyHeatmap = hourly.hourlyHeatmap
  data.segments = buildSegments(channelTotals)
  data.rankings = buildRankings(sellerTotals, sellerCounts)
  return { success: true, data }
}
