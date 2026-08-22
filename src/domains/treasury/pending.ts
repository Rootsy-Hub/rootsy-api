import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "../reports/money.js"
import {
  computeChartAccountBalanceAsOf,
  resolveTreasuryAccountLedgerAccountId,
} from "./chart.js"
import {
  isCardPayableChartCode,
  isSettlementReceivableChartCode,
  type TreasuryAccountKind,
} from "./kinds.js"

export type TreasuryAccountMeta = {
  name: string
  kind: TreasuryAccountKind
  chartCode: string
}

async function computePaidOutAsOf(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
  asOfDate: string,
): Promise<number> {
  let total = 0
  for (const table of ["purchase_payments", "expense_payments"] as const) {
    const { data } = await supabase
      .from(table)
      .select("amount, paid_at")
      .eq("pop_id", popId)
      .eq("treasury_account_id", treasuryAccountId)
      .lte("paid_at", asOfDate)
    for (const row of data || []) {
      total = roundMoney(total + parseMoney(row.amount))
    }
  }
  return total
}

async function computeSettledPrincipalAsOf(
  supabase: SupabaseClient,
  popId: string,
  cardTreasuryAccountId: string,
  asOfDate: string,
): Promise<number> {
  const { data } = await supabase
    .from("treasury_settlements")
    .select("principal_amount, amount, settled_at")
    .eq("pop_id", popId)
    .eq("card_treasury_account_id", cardTreasuryAccountId)
    .lte("settled_at", asOfDate)
  let total = 0
  for (const row of data || []) {
    total = roundMoney(total + parseMoney(row.principal_amount ?? row.amount))
  }
  return total
}

async function computeChildPendingBalanceAsOf(
  supabase: SupabaseClient,
  popId: string,
  childTreasuryAccountId: string,
  childRole: "pos" | "card_payable",
  asOfDate: string,
): Promise<number> {
  if (childRole === "pos") {
    const ledgerId = await resolveTreasuryAccountLedgerAccountId(
      supabase,
      popId,
      childTreasuryAccountId,
    )
    if (!ledgerId) return 0
    return computeChartAccountBalanceAsOf(supabase, popId, ledgerId, asOfDate)
  }
  const charged = await computePaidOutAsOf(
    supabase,
    popId,
    childTreasuryAccountId,
    asOfDate,
  )
  const settled = await computeSettledPrincipalAsOf(
    supabase,
    popId,
    childTreasuryAccountId,
    asOfDate,
  )
  return roundMoney(Math.max(0, charged - settled))
}

export async function computeMotherPendingTotalsAsOf(
  supabase: SupabaseClient,
  popId: string,
  relatedIds: string[],
  accountMeta: Map<string, TreasuryAccountMeta>,
  asOfDate: string,
): Promise<{ toLiquidate: number; toPay: number }> {
  let toLiquidate = 0
  let toPay = 0
  for (const childId of relatedIds) {
    const meta = accountMeta.get(childId)
    if (!meta) continue
    if (isSettlementReceivableChartCode(meta.chartCode)) {
      const balance = await computeChildPendingBalanceAsOf(
        supabase,
        popId,
        childId,
        "pos",
        asOfDate,
      )
      toLiquidate = roundMoney(toLiquidate + balance)
    } else if (
      isCardPayableChartCode(meta.chartCode) ||
      meta.kind === "card_payable"
    ) {
      const balance = await computeChildPendingBalanceAsOf(
        supabase,
        popId,
        childId,
        "card_payable",
        asOfDate,
      )
      toPay = roundMoney(toPay + balance)
    }
  }
  return { toLiquidate, toPay }
}
