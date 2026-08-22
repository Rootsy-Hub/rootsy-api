import type { SupabaseClient } from "@supabase/supabase-js"
import { getIncomeStatement } from "../reports/accounting.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { addCalendarDays } from "../operations/timezone.js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import { COST_KIND_LABELS, fetchArticleItemKindsById } from "./catalog.js"
import {
  compareMetric,
  comparePercentMetric,
  dayLabel,
  ratioOverSales,
} from "./compare.js"
import { loadSlimSales } from "./loaders.js"
import { emptySection, type SectionQuery, type StatisticsSectionData } from "./schema.js"

async function incomeTotals(
  supabase: SupabaseClient,
  popId: string,
  from: string | null,
  to: string | null,
) {
  const res = await getIncomeStatement(supabase, popId, from, to)
  if (!res.success) {
    return { ingresos: 0, costos: 0, gastos: 0, resultado: 0, margen: 0 }
  }
  const ingresos = res.data.totalIngresos
  const costos = res.data.totalCostos
  const gastos = res.data.totalGastos
  const ganancia = roundMoney(ingresos - costos)
  return {
    ingresos,
    costos,
    gastos,
    resultado: res.data.resultadoNeto,
    margen: ingresos > 0 ? roundMoney((ganancia / ingresos) * 100) : 0,
  }
}

export async function getProfitabilitySummary(
  supabase: SupabaseClient,
  popId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const [current, previous] = await Promise.all([
    incomeTotals(supabase, popId, query.from, query.to),
    incomeTotals(supabase, popId, query.prevFrom, query.prevTo),
  ])
  const ganancia = roundMoney(current.ingresos - current.costos)
  const prevGanancia = roundMoney(previous.ingresos - previous.costos)
  const data = emptySection("profitability", "Rentabilidad")
  data.comparison = [
    compareMetric("costs", "Costo de ventas", current.costos, previous.costos, "money"),
    compareMetric("gross", "Ganancia bruta", ganancia, prevGanancia, "money"),
    compareMetric("expenses", "Gastos", current.gastos, previous.gastos, "money"),
    compareMetric("result", "Resultado neto", current.resultado, previous.resultado, "money"),
  ]
  data.efficiencyRatios = [
    comparePercentMetric("margin-on-sales", "Margen sobre ventas", current.margen, previous.margen),
    comparePercentMetric(
      "costs-on-sales",
      "Costos sobre ventas",
      ratioOverSales(current.costos, current.ingresos),
      ratioOverSales(previous.costos, previous.ingresos),
    ),
    comparePercentMetric(
      "expenses-on-sales",
      "Gastos sobre ventas",
      ratioOverSales(current.gastos, current.ingresos),
      ratioOverSales(previous.gastos, previous.ingresos),
    ),
    comparePercentMetric(
      "result-on-sales",
      "Resultado sobre ventas",
      ratioOverSales(current.resultado, current.ingresos),
      ratioOverSales(previous.resultado, previous.ingresos),
    ),
  ]
  data.segments = [
    { label: "Ingresos", value: current.ingresos, percent: 100 },
    {
      label: "Costos",
      value: current.costos,
      percent: ratioOverSales(current.costos, current.ingresos),
    },
    {
      label: "Gastos",
      value: current.gastos,
      percent: ratioOverSales(current.gastos, current.ingresos),
    },
  ].filter((row) => row.value > 0)
  data.resultWaterfall = [
    { id: "ingresos", label: "Ingresos", kind: "increase", amount: current.ingresos },
    { id: "costos", label: "Costos", kind: "decrease", amount: current.costos },
    { id: "gastos", label: "Gastos", kind: "decrease", amount: current.gastos },
    { id: "resultado", label: "Resultado", kind: "total", amount: current.resultado },
  ]
  return { success: true, data }
}

export async function getProfitabilityDetails(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const from = query.from
  const to = query.to
  const buckets = new Map<string, { ingresos: number; costos: number }>()
  let entQ = supabase
    .from("accounting_entries")
    .select("id, entry_date")
    .eq("pop_id", popId)
    .eq("status", "posted")
  if (from) entQ = entQ.gte("entry_date", from)
  if (to) entQ = entQ.lte("entry_date", to)
  const { data: entries } = await entQ
  const entryDateById = new Map<string, string>()
  for (const entry of entries || []) {
    const date = String(entry.entry_date ?? "").slice(0, 10)
    if (date) entryDateById.set(String(entry.id), date)
  }
  const entryIds = [...entryDateById.keys()]
  for (let i = 0; i < entryIds.length; i += 400) {
    const chunk = entryIds.slice(i, i + 400)
    const { data: lines } = await supabase
      .from("accounting_entry_lines")
      .select(
        "entry_id, debit_amount, credit_amount, accounting_chart_of_accounts ( account_type, nature )",
      )
      .in("entry_id", chunk)
    for (const line of lines || []) {
      const day = entryDateById.get(String(line.entry_id))
      if (!day) continue
      const account = line.accounting_chart_of_accounts as {
        account_type?: string
        nature?: string
      } | null
      const accountType = String(account?.account_type ?? "")
      if (accountType !== "ingresos" && accountType !== "costos") continue
      const debit = parseMoney(line.debit_amount)
      const credit = parseMoney(line.credit_amount)
      const contribution =
        String(account?.nature ?? "deudora") === "deudora"
          ? roundMoney(debit - credit)
          : roundMoney(credit - debit)
      const bucket = buckets.get(day) ?? { ingresos: 0, costos: 0 }
      if (accountType === "ingresos") bucket.ingresos = roundMoney(bucket.ingresos + contribution)
      else bucket.costos = roundMoney(bucket.costos + contribution)
      buckets.set(day, bucket)
    }
  }

  const evolution = []
  if (from && to) {
    let cursor = from
    while (cursor <= to) {
      const bucket = buckets.get(cursor) ?? { ingresos: 0, costos: 0 }
      const ganancia = roundMoney(bucket.ingresos - bucket.costos)
      evolution.push({
        label: dayLabel(cursor),
        value: ganancia,
        count: bucket.ingresos > 0 ? ratioOverSales(ganancia, bucket.ingresos) : 0,
      })
      cursor = addCalendarDays(cursor, 1)
    }
  }

  const kindTotals = new Map<string, number>([
    ["merchandise", 0],
    ["raw_material", 0],
    ["supply", 0],
  ])
  const currentSales = await loadSlimSales(
    supabase,
    popId,
    popSiteId,
    from,
    to,
    query.channel,
    true,
  )
  const articleIds = [
    ...new Set(
      currentSales.sales.flatMap((sale) =>
        sale.lineItems
          .map((line) => line.articleId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ]
  const [kindByArticle, unitCosts] = await Promise.all([
    fetchArticleItemKindsById(supabase, popId, articleIds),
    resolveArticleReferenceUnitCostsByArticleId(supabase, popId, articleIds),
  ])
  for (const sale of currentSales.sales) {
    for (const line of sale.lineItems) {
      if (!line.articleId) continue
      const kind = kindByArticle.get(line.articleId)
      if (!kind || !kindTotals.has(kind)) continue
      const unitCost = unitCosts.get(line.articleId) ?? 0
      if (unitCost <= 0) continue
      kindTotals.set(
        kind,
        (kindTotals.get(kind) ?? 0) + roundMoney(line.quantity * unitCost),
      )
    }
  }
  const grand = [...kindTotals.values()].reduce((sum, value) => sum + value, 0)
  const costDistribution =
    grand > 0
      ? [...kindTotals.entries()]
          .filter(([, value]) => value > 0)
          .map(([kind, value]) => ({
            label:
              COST_KIND_LABELS[kind as keyof typeof COST_KIND_LABELS] ?? kind,
            value: roundMoney(value),
            percent: ratioOverSales(value, grand),
          }))
      : []

  const data = emptySection("profitability", "Rentabilidad")
  data.evolution = evolution
  data.costDistribution = costDistribution
  return { success: true, data }
}
