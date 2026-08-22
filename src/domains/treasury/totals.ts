import type { SupabaseClient } from "@supabase/supabase-js"
import { getTreasuryAccountBalances } from "./balances.js"
import {
  computeChartAccountBalanceAsOf,
  computeChartAccountPeriodFlow,
  resolveTreasuryAccountLedgerAccountId,
} from "./chart.js"
import { isMotherTreasuryAccount, parseTreasuryKind } from "./kinds.js"
import type { TreasuryAccountTotals } from "./schema.js"

function dayBeforeIso(isoDate: string): string {
  const dt = new Date(`${isoDate.slice(0, 10)}T12:00:00`)
  dt.setDate(dt.getDate() - 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
}

function closingAsOf(to: string | null): string {
  const today = new Date()
  return (
    to?.trim() ||
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  )
}

export async function getTreasuryAccountTotals(
  supabase: SupabaseClient,
  popId: string,
  accountId: string,
  from: string | null,
  to: string | null,
): Promise<
  | { success: true; data: TreasuryAccountTotals }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: taRow, error } = await supabase
    .from("treasury_accounts")
    .select(
      `
      id,
      kind,
      parent_treasury_account_id,
      accounting_chart_of_accounts ( code )
    `,
    )
    .eq("id", accountId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error) {
    return { success: false, error: error.message || "Error", status: 500 }
  }
  if (!taRow?.id) {
    return { success: false, error: "Cuenta no encontrada.", status: 404 }
  }

  const kind = parseTreasuryKind(taRow.kind)
  const chart = taRow.accounting_chart_of_accounts as unknown as {
    code?: string
  } | null
  const chartCode = String(chart?.code ?? "")
  const isMother = isMotherTreasuryAccount(chartCode)
  const isCard = kind === "card_payable"

  const hubBalances = await getTreasuryAccountBalances(supabase, popId)
  if (!hubBalances.success) {
    return { success: false, error: hubBalances.error, status: 500 }
  }
  const self = hubBalances.data.balances[accountId]
  const { data: childRows } = isMother
    ? await supabase
        .from("treasury_accounts")
        .select("id")
        .eq("pop_id", popId)
        .eq("parent_treasury_account_id", accountId)
    : { data: [] as Array<{ id: string }> }

  const children = (childRows || []).map((row) => {
    const id = String(row.id)
    const bal = hubBalances.data.balances[id]
    return {
      id,
      ledgerBalance: bal?.ledgerBalance ?? null,
      outstandingBalance: bal?.outstandingBalance ?? 0,
      settledTotal: bal?.settledTotal ?? 0,
    }
  })

  const asOf = closingAsOf(to)
  const ledgerId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    accountId,
  )

  let openingBalance: number | null = null
  let currentBalance: number | null = self?.ledgerBalance ?? null
  let periodIn = 0
  let periodOut = 0

  if (ledgerId) {
    const [flow, current, opening] = await Promise.all([
      computeChartAccountPeriodFlow(supabase, popId, ledgerId, from, to),
      computeChartAccountBalanceAsOf(supabase, popId, ledgerId, asOf),
      from?.trim()
        ? computeChartAccountBalanceAsOf(
            supabase,
            popId,
            ledgerId,
            dayBeforeIso(from.trim()),
          )
        : Promise.resolve(null),
    ])
    periodIn = flow.in
    periodOut = flow.out
    currentBalance = current
    openingBalance = opening
  }

  return {
    success: true,
    data: {
      ledgerBalance: self?.ledgerBalance ?? currentBalance,
      toLiquidateBalance: self?.toLiquidateBalance ?? 0,
      toPayBalance: self?.toPayBalance ?? 0,
      openingBalance: isMother && !isCard ? openingBalance : null,
      currentBalance: isMother && !isCard ? currentBalance : null,
      periodIn,
      periodOut,
      children,
    },
  }
}
