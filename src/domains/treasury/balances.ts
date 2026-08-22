import type { SupabaseClient } from "@supabase/supabase-js"
import {
  childRoleOf,
  isMotherRow,
  loadAllTreasuryAccounts,
  type RawTreasuryAccount,
} from "./accounts.js"
import { computeLedgerBalancesByAccountIds } from "./chart.js"
import {
  isCardPayableChartCode,
  isSettlementReceivableChartCode,
} from "./kinds.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import type { TreasuryAccountBalance } from "./schema.js"

async function lifetimePaidByTreasuryAccount(
  supabase: SupabaseClient,
  popId: string,
  accountIds: string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>()
  if (accountIds.length === 0) return totals
  for (const table of [
    "purchase_payments",
    "expense_payments",
    "pop_employee_payments",
  ] as const) {
    const { data } = await supabase
      .from(table)
      .select("treasury_account_id, amount")
      .eq("pop_id", popId)
      .in("treasury_account_id", accountIds)
    for (const row of data || []) {
      const id =
        row.treasury_account_id != null ? String(row.treasury_account_id) : ""
      if (!id) continue
      totals.set(id, roundMoney((totals.get(id) ?? 0) + parseMoney(row.amount)))
    }
  }
  return totals
}

async function settlementsByTreasuryAccount(
  supabase: SupabaseClient,
  popId: string,
  accountIds: string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>()
  if (accountIds.length === 0) return totals
  const { data } = await supabase
    .from("treasury_settlements")
    .select("card_treasury_account_id, amount")
    .eq("pop_id", popId)
    .in("card_treasury_account_id", accountIds)
  for (const row of data || []) {
    const id =
      row.card_treasury_account_id != null
        ? String(row.card_treasury_account_id)
        : ""
    if (!id) continue
    totals.set(id, roundMoney((totals.get(id) ?? 0) + parseMoney(row.amount)))
  }
  return totals
}

function emptyBalance(): TreasuryAccountBalance {
  return {
    ledgerBalance: null,
    toLiquidateBalance: 0,
    toPayBalance: 0,
    outstandingBalance: 0,
    settledTotal: 0,
  }
}

export async function getTreasuryAccountBalances(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: { balances: Record<string, TreasuryAccountBalance> } }
  | { success: false; error: string }
> {
  const loaded = await loadAllTreasuryAccounts(supabase, popId)
  if (!loaded.success) return loaded

  const chartIds = loaded.rows.map((row) => row.chartAccountId)
  const cardIds = loaded.rows
    .filter(
      (row) =>
        row.kind === "card_payable" ||
        isCardPayableChartCode(row.chartAccountCode),
    )
    .map((row) => row.id)

  const [ledgers, paid, settled] = await Promise.all([
    computeLedgerBalancesByAccountIds(supabase, popId, chartIds),
    lifetimePaidByTreasuryAccount(supabase, popId, cardIds),
    settlementsByTreasuryAccount(supabase, popId, cardIds),
  ])

  const balances: Record<string, TreasuryAccountBalance> = {}

  for (const row of loaded.rows) {
    const ledger = ledgers.get(row.chartAccountId) ?? 0
    const isCard =
      row.kind === "card_payable" || isCardPayableChartCode(row.chartAccountCode)
    const charged = paid.get(row.id) ?? 0
    const settledTotal = settled.get(row.id) ?? 0
    balances[row.id] = {
      ledgerBalance: ledger,
      toLiquidateBalance: isSettlementReceivableChartCode(row.chartAccountCode)
        ? ledger
        : 0,
      toPayBalance: isCard ? ledger : 0,
      outstandingBalance: isCard ? roundMoney(charged - settledTotal) : 0,
      settledTotal,
    }
  }

  for (const mother of loaded.rows.filter(isMotherRow)) {
    const current = balances[mother.id] ?? emptyBalance()
    let toLiquidate = 0
    let toPay = 0
    for (const child of childrenOf(mother.id, loaded.rows)) {
      const childBal = balances[child.id]
      const childLedger = childBal?.ledgerBalance ?? 0
      if (isSettlementReceivableChartCode(child.chartAccountCode)) {
        toLiquidate = roundMoney(toLiquidate + childLedger)
      } else if (
        isCardPayableChartCode(child.chartAccountCode) ||
        child.kind === "card_payable"
      ) {
        toPay = roundMoney(toPay + childLedger)
      }
    }
    balances[mother.id] = {
      ...current,
      toLiquidateBalance: toLiquidate,
      toPayBalance: toPay,
    }
  }

  return { success: true, data: { balances } }
}

function childrenOf(
  motherId: string,
  rows: RawTreasuryAccount[],
): RawTreasuryAccount[] {
  return rows.filter((row) => row.parentTreasuryAccountId === motherId)
}
