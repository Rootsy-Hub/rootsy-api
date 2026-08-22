import type { SupabaseClient } from "@supabase/supabase-js"
import {
  expandCalendarBoundsForOperationalFetch,
  isOperationalDayInRange,
  loadPopOperationalContext,
  operationalDayKey,
} from "../operations/operationalDay.js"
import { addCalendarDays } from "../operations/timezone.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { computeChartAccountBalanceAsOf } from "../treasury/chart.js"
import { isMotherTreasuryAccount } from "../treasury/kinds.js"
import {
  getTreasuryPeriodReport,
  getTreasuryPeriodTotals,
} from "../treasury/period.js"
import { buildSegments, compareMetric, dayLabel, ratioOverSales } from "./compare.js"
import {
  emptySection,
  type SectionQuery,
  type StatisticsEvolutionPoint,
  type StatisticsSectionData,
} from "./schema.js"

const CHART_CUENTAS_POR_COBRAR = ["1.1.2.01"] as const
const CHART_PROVEEDORES_CC = ["2.1.1.01"] as const
const CHART_DOCUMENTOS_POR_COBRAR = ["1.1.2.02"] as const
const CHART_DOCUMENTOS_A_PAGAR = ["2.1.1.02"] as const

function closingAsOf(to: string | null): string {
  const today = new Date()
  return (
    to?.trim() ||
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  )
}

function positiveBalance(value: number): number {
  return roundMoney(Math.max(0, value))
}

async function sumChartBalancesByCodes(
  supabase: SupabaseClient,
  popId: string,
  codes: readonly string[],
  asOf: string,
): Promise<number> {
  const { data } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id")
    .eq("pop_id", popId)
    .in("code", [...codes])
  const ids = (data || []).map((row) => String(row.id)).filter(Boolean)
  if (ids.length === 0) return 0
  const balances = await Promise.all(
    ids.map((id) => computeChartAccountBalanceAsOf(supabase, popId, id, asOf)),
  )
  return roundMoney(balances.reduce((sum, value) => sum + value, 0))
}

async function loadMotherTreasuryChartAccounts(
  supabase: SupabaseClient,
  popId: string,
): Promise<Array<{ chartAccountId: string; nature: string }>> {
  const { data } = await supabase
    .from("treasury_accounts")
    .select(
      `
      accounting_chart_account_id,
      accounting_chart_of_accounts ( id, code, nature )
    `,
    )
    .eq("pop_id", popId)
    .eq("is_active", true)
  const accounts: Array<{ chartAccountId: string; nature: string }> = []
  for (const row of data || []) {
    const chart = row.accounting_chart_of_accounts as {
      id?: string
      code?: string
      nature?: string
    } | null
    const code = String(chart?.code ?? "")
    if (!isMotherTreasuryAccount(code)) continue
    const chartAccountId = String(
      chart?.id ?? row.accounting_chart_account_id ?? "",
    )
    if (!chartAccountId) continue
    accounts.push({
      chartAccountId,
      nature: String(chart?.nature ?? "deudora"),
    })
  }
  return accounts
}

async function fetchTreasuryMotherDailyFlow(
  supabase: SupabaseClient,
  popId: string,
  from: string | null,
  to: string | null,
  timeZone: string,
  operationalDayCloseTime: string,
): Promise<Map<string, { ingresos: number; egresos: number }>> {
  const metricsByDay = new Map<string, { ingresos: number; egresos: number }>()
  if (!from || !to) return metricsByDay
  const mothers = await loadMotherTreasuryChartAccounts(supabase, popId)
  if (mothers.length === 0) return metricsByDay
  const motherIds = new Set(mothers.map((account) => account.chartAccountId))
  const natureByAccountId = new Map(
    mothers.map((account) => [account.chartAccountId, account.nature]),
  )
  const bounds = expandCalendarBoundsForOperationalFetch(from, to)
  const { data: entries } = await supabase
    .from("accounting_entries")
    .select("id, entry_date, posted_at")
    .eq("pop_id", popId)
    .eq("status", "posted")
    .gte("entry_date", bounds.from ?? from)
    .lte("entry_date", bounds.to ?? to)
  if (!entries?.length) return metricsByDay

  const entryDayById = new Map<string, string>()
  for (const entry of entries) {
    const id = String(entry.id)
    const entryDate = String(entry.entry_date ?? "").slice(0, 10)
    const postedAt = String(entry.posted_at ?? "").trim()
    const anchor = postedAt || (entryDate ? `${entryDate}T12:00:00` : "")
    if (!anchor) continue
    const operationalDay = operationalDayKey(
      anchor,
      timeZone,
      operationalDayCloseTime,
    )
    if (!isOperationalDayInRange(operationalDay, from, to)) continue
    entryDayById.set(id, operationalDay)
  }

  const entryIds = [...entryDayById.keys()]
  for (let i = 0; i < entryIds.length; i += 400) {
    const chunk = entryIds.slice(i, i + 400)
    const { data: lines } = await supabase
      .from("accounting_entry_lines")
      .select("entry_id, account_id, debit_amount, credit_amount")
      .in("entry_id", chunk)
      .in("account_id", [...motherIds])
    for (const line of lines || []) {
      const accountId = String(line.account_id ?? "")
      const day = entryDayById.get(String(line.entry_id))
      if (!day) continue
      const debit = parseMoney(line.debit_amount)
      const credit = parseMoney(line.credit_amount)
      const nature = natureByAccountId.get(accountId) ?? "deudora"
      const prev = metricsByDay.get(day) ?? { ingresos: 0, egresos: 0 }
      if (nature === "acreedora") {
        prev.ingresos = roundMoney(prev.ingresos + credit)
        prev.egresos = roundMoney(prev.egresos + debit)
      } else {
        prev.ingresos = roundMoney(prev.ingresos + debit)
        prev.egresos = roundMoney(prev.egresos + credit)
      }
      metricsByDay.set(day, prev)
    }
  }
  return metricsByDay
}

function dailyFlowPoints(
  metricsByDay: Map<string, { ingresos: number; egresos: number }>,
  from: string | null,
  to: string | null,
): StatisticsEvolutionPoint[] {
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

export async function getFinanceSummary(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const asOf = closingAsOf(query.to)
  const [totalsRes, operational, ccPorCobrar, ccPorPagar, chequesPorCobrar, chequesPorPagar] =
    await Promise.all([
      getTreasuryPeriodTotals(supabase, popId, query.from, query.to),
      loadPopOperationalContext(supabase, popId, popSiteId),
      sumChartBalancesByCodes(supabase, popId, CHART_CUENTAS_POR_COBRAR, asOf),
      sumChartBalancesByCodes(supabase, popId, CHART_PROVEEDORES_CC, asOf),
      sumChartBalancesByCodes(supabase, popId, CHART_DOCUMENTOS_POR_COBRAR, asOf),
      sumChartBalancesByCodes(supabase, popId, CHART_DOCUMENTOS_A_PAGAR, asOf),
    ])
  if (!totalsRes.success) return totalsRes
  const ingresos = totalsRes.data.periodIn
  const egresos = totalsRes.data.periodOut
  const neto = roundMoney(ingresos - egresos)
  const data = emptySection(
    "finance",
    "Finanzas",
    "Ingresos y egresos en cuentas de tesorería",
  )
  data.operationalDayCloseTime = operational.operationalDayCloseTime
  data.comparison = [
    compareMetric(
      "in",
      "Ingresos",
      ingresos,
      0,
      "money",
      "No incluye cobros pendientes por terminales POS.",
    ),
    compareMetric(
      "out",
      "Egresos",
      egresos,
      0,
      "money",
      "No incluye pagos pendientes de tarjetas.",
    ),
    compareMetric("net", "Neto", neto, 0, "money"),
    compareMetric("margin", "Margen neto", ratioOverSales(neto, ingresos), 0, "percent"),
  ]
  data.commitmentMetrics = [
    compareMetric(
      "cc-receivable",
      "Cuentas corrientes por cobrar",
      positiveBalance(ccPorCobrar),
      0,
      "money",
    ),
    compareMetric(
      "cc-payable",
      "Cuentas corrientes por pagar",
      positiveBalance(ccPorPagar),
      0,
      "money",
    ),
    compareMetric(
      "check-receivable",
      "Cheques por cobrar",
      positiveBalance(chequesPorCobrar),
      0,
      "money",
    ),
    compareMetric(
      "check-payable",
      "Cheques por pagar",
      positiveBalance(chequesPorPagar),
      0,
      "money",
    ),
  ]
  return { success: true, data }
}

export async function getFinanceDetails(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  query: SectionQuery,
): Promise<
  { success: true; data: StatisticsSectionData } | { success: false; error: string }
> {
  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const [reportRes, dailyFlow] = await Promise.all([
    getTreasuryPeriodReport(supabase, popId, query.from, query.to),
    fetchTreasuryMotherDailyFlow(
      supabase,
      popId,
      query.from,
      query.to,
      operational.timeZone,
      operational.operationalDayCloseTime,
    ),
  ])
  if (!reportRes.success) return reportRes
  const rows = reportRes.data.rows
  const treasuryInflows = new Map<string, number>()
  let tarjetasPorLiquidar = 0
  let tarjetasPorPagar = 0
  for (const row of rows) {
    if (row.periodIn > 0) {
      treasuryInflows.set(
        row.name,
        roundMoney((treasuryInflows.get(row.name) ?? 0) + row.periodIn),
      )
    }
    if (!row.isActive) continue
    tarjetasPorLiquidar += row.toLiquidateBalance ?? 0
    tarjetasPorPagar += row.toPayBalance ?? 0
  }

  const data = emptySection(
    "finance",
    "Finanzas",
    "Ingresos y egresos en cuentas de tesorería",
  )
  data.operationalDayCloseTime = operational.operationalDayCloseTime
  data.evolution = dailyFlowPoints(dailyFlow, query.from, query.to)
  data.segments = buildSegments(treasuryInflows, 8)
  data.commitmentMetrics = [
    compareMetric(
      "card-receivable",
      "Terminales POS por liquidar",
      roundMoney(tarjetasPorLiquidar),
      0,
      "money",
    ),
    compareMetric(
      "card-payable",
      "Tarjetas por pagar",
      roundMoney(tarjetasPorPagar),
      0,
      "money",
    ),
  ]
  return { success: true, data }
}
