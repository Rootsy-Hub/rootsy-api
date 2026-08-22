import type { SupabaseClient } from "@supabase/supabase-js"
import { roundMoney } from "../reports/money.js"
import {
  computeChartAccountBalanceAsOf,
  computeChartAccountPeriodFlow,
} from "./chart.js"
import {
  isCardPayableChartCode,
  isMotherTreasuryAccount,
  isSettlementReceivableChartCode,
  parseTreasuryKind,
} from "./kinds.js"
import { computeMotherPendingTotalsAsOf, type TreasuryAccountMeta } from "./pending.js"
import type {
  TreasuryPeriodData,
  TreasuryPeriodPopInfo,
  TreasuryPeriodReportRow,
  TreasuryPeriodTotals,
} from "./schema.js"

function dayBeforeIso(isoDate: string): string {
  const dt = new Date(`${isoDate.slice(0, 10)}T12:00:00`)
  dt.setDate(dt.getDate() - 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
}

function compareTreasuryChartAccountCodes(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

async function loadPeriodPopInfo(
  supabase: SupabaseClient,
  popId: string,
): Promise<TreasuryPeriodPopInfo> {
  const { data } = await supabase
    .from("pops")
    .select("name, street_address, fiscal_cuit, fiscal_razon_social")
    .eq("id", popId)
    .maybeSingle()
  return {
    popName: data?.name != null ? String(data.name).trim() : "",
    popStreetAddress:
      data?.street_address != null ? String(data.street_address).trim() : null,
    popFiscalCuit:
      data?.fiscal_cuit != null ? String(data.fiscal_cuit).trim() : null,
    popFiscalRazonSocial:
      data?.fiscal_razon_social != null
        ? String(data.fiscal_razon_social).trim()
        : null,
  }
}

type RawTreasuryRow = {
  id: string
  name: string
  kind: ReturnType<typeof parseTreasuryKind>
  brandKey: string | null
  isActive: boolean
  chartAccountId: string
  chartAccountCode: string
  parentTreasuryAccountId: string | null
}

async function loadTreasuryRows(
  supabase: SupabaseClient,
  popId: string,
): Promise<{ success: true; rows: RawTreasuryRow[] } | { success: false; error: string }> {
  const { data, error } = await supabase
    .from("treasury_accounts")
    .select(
      `
      id,
      name,
      kind,
      is_active,
      brand_key,
      parent_treasury_account_id,
      accounting_chart_account_id,
      accounting_chart_of_accounts ( code )
    `,
    )
    .eq("pop_id", popId)
    .order("name", { ascending: true })

  if (error) {
    return {
      success: false,
      error: error.message || "No se pudieron cargar las cuentas.",
    }
  }

  const rows: RawTreasuryRow[] = (data || []).map((row) => {
    const chart = row.accounting_chart_of_accounts as unknown as {
      code?: string
    } | null
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      kind: parseTreasuryKind(row.kind),
      brandKey: row.brand_key != null ? String(row.brand_key) : null,
      isActive: Boolean(row.is_active),
      chartAccountId: String(row.accounting_chart_account_id),
      chartAccountCode: String(chart?.code ?? ""),
      parentTreasuryAccountId:
        row.parent_treasury_account_id != null
          ? String(row.parent_treasury_account_id)
          : null,
    }
  })
  return { success: true, rows }
}

function closingAsOf(to: string | null): string {
  const today = new Date()
  return (
    to?.trim() ||
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  )
}

export async function getTreasuryPeriodTotals(
  supabase: SupabaseClient,
  popId: string,
  from: string | null,
  to: string | null,
): Promise<
  { success: true; data: TreasuryPeriodTotals } | { success: false; error: string }
> {
  const loaded = await loadTreasuryRows(supabase, popId)
  if (!loaded.success) return loaded
  const mothers = loaded.rows.filter((row) =>
    isMotherTreasuryAccount(row.chartAccountCode),
  )
  const asOf = closingAsOf(to)

  const stats = await Promise.all(
    mothers.map(async (mother) => {
      const [closingBalance, periodFlow] = await Promise.all([
        computeChartAccountBalanceAsOf(
          supabase,
          popId,
          mother.chartAccountId,
          asOf,
        ),
        computeChartAccountPeriodFlow(
          supabase,
          popId,
          mother.chartAccountId,
          from,
          to,
        ),
      ])
      return { closingBalance, periodIn: periodFlow.in, periodOut: periodFlow.out }
    }),
  )

  return {
    success: true,
    data: {
      accountCount: mothers.length,
      closingBalance: roundMoney(
        stats.reduce((a, s) => a + s.closingBalance, 0),
      ),
      periodIn: roundMoney(stats.reduce((a, s) => a + s.periodIn, 0)),
      periodOut: roundMoney(stats.reduce((a, s) => a + s.periodOut, 0)),
    },
  }
}

export async function getTreasuryPeriodReport(
  supabase: SupabaseClient,
  popId: string,
  from: string | null,
  to: string | null,
): Promise<
  { success: true; data: TreasuryPeriodData } | { success: false; error: string }
> {
  const [loaded, popInfo] = await Promise.all([
    loadTreasuryRows(supabase, popId),
    loadPeriodPopInfo(supabase, popId),
  ])
  if (!loaded.success) return loaded

  const mothers = loaded.rows.filter((row) =>
    isMotherTreasuryAccount(row.chartAccountCode),
  )
  if (mothers.length === 0) {
    return { success: true, data: { rows: [], popInfo } }
  }

  const childrenByMother = new Map<string, RawTreasuryRow[]>()
  for (const row of loaded.rows) {
    if (!row.parentTreasuryAccountId) continue
    const bucket = childrenByMother.get(row.parentTreasuryAccountId) ?? []
    bucket.push(row)
    childrenByMother.set(row.parentTreasuryAccountId, bucket)
  }

  const asOf = closingAsOf(to)
  const openingAsOf = from?.trim() ? dayBeforeIso(from.trim()) : null

  const reportRows = await Promise.all(
    mothers.map(async (mother) => {
      const childRows = childrenByMother.get(mother.id) ?? []
      const childIds = childRows.map((child) => child.id)
      const accountMeta = new Map<string, TreasuryAccountMeta>()
      for (const child of childRows) {
        accountMeta.set(child.id, {
          name: child.name,
          kind: child.kind,
          chartCode: child.chartAccountCode,
        })
      }

      const hasPosIntegration = childRows.some((child) =>
        isSettlementReceivableChartCode(child.chartAccountCode),
      )
      const hasCardIntegration = childRows.some(
        (child) =>
          isCardPayableChartCode(child.chartAccountCode) ||
          child.kind === "card_payable",
      )

      const [openingBalance, closingBalance, periodFlow, pendingTotals] =
        await Promise.all([
          openingAsOf
            ? computeChartAccountBalanceAsOf(
                supabase,
                popId,
                mother.chartAccountId,
                openingAsOf,
              )
            : Promise.resolve(null),
          computeChartAccountBalanceAsOf(
            supabase,
            popId,
            mother.chartAccountId,
            asOf,
          ),
          computeChartAccountPeriodFlow(
            supabase,
            popId,
            mother.chartAccountId,
            from,
            to,
          ),
          childIds.length > 0
            ? computeMotherPendingTotalsAsOf(
                supabase,
                popId,
                childIds,
                accountMeta,
                asOf,
              )
            : Promise.resolve({ toLiquidate: 0, toPay: 0 }),
        ])

      const showSettlementStats =
        mother.kind === "bank" || mother.kind === "wallet"

      return {
        id: mother.id,
        name: mother.name,
        kind: mother.kind,
        brandKey: mother.brandKey,
        isActive: mother.isActive,
        chartAccountCode: mother.chartAccountCode,
        openingBalance,
        closingBalance,
        periodIn: periodFlow.in,
        periodOut: periodFlow.out,
        toLiquidateBalance:
          showSettlementStats && hasPosIntegration
            ? pendingTotals.toLiquidate
            : null,
        toPayBalance:
          showSettlementStats && hasCardIntegration
            ? pendingTotals.toPay
            : null,
        hasPosIntegration,
        hasCardIntegration,
      } satisfies TreasuryPeriodReportRow
    }),
  )

  reportRows.sort((a, b) =>
    compareTreasuryChartAccountCodes(a.chartAccountCode, b.chartAccountCode),
  )

  return {
    success: true,
    data: {
      rows: reportRows,
      popInfo,
    },
  }
}
