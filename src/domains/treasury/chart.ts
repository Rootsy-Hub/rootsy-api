import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "../reports/money.js"

const LINE_PAGE = 1000

export async function resolveTreasuryAccountLedgerAccountId(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("treasury_accounts")
    .select("accounting_chart_account_id")
    .eq("pop_id", popId)
    .eq("id", treasuryAccountId)
    .maybeSingle()
  return data?.accounting_chart_account_id
    ? String(data.accounting_chart_account_id)
    : null
}

async function sumAccountLines(
  supabase: SupabaseClient,
  popId: string,
  chartAccountId: string,
  fromDate: string | null,
  toDate: string | null,
  throughDate: string | null,
): Promise<{ debit: number; credit: number } | { error: string }> {
  let debit = 0
  let credit = 0
  let from = 0
  while (true) {
    let q = supabase
      .from("accounting_entry_lines")
      .select(
        `
        debit_amount,
        credit_amount,
        accounting_entries!inner ( pop_id, status, entry_date )
      `,
      )
      .eq("account_id", chartAccountId)
      .eq("accounting_entries.pop_id", popId)
      .eq("accounting_entries.status", "posted")
      .range(from, from + LINE_PAGE - 1)

    if (throughDate) {
      q = q.lte("accounting_entries.entry_date", throughDate)
    } else {
      if (fromDate) q = q.gte("accounting_entries.entry_date", fromDate)
      if (toDate) q = q.lte("accounting_entries.entry_date", toDate)
    }

    const { data, error } = await q
    if (error) {
      return { error: error.message || "No se pudieron leer líneas contables." }
    }
    const rows = data || []
    for (const row of rows) {
      debit += parseMoney(row.debit_amount)
      credit += parseMoney(row.credit_amount)
    }
    if (rows.length < LINE_PAGE) break
    from += LINE_PAGE
    if (from > 200_000) break
  }
  return { debit: roundMoney(debit), credit: roundMoney(credit) }
}

export async function computeChartAccountBalanceAsOf(
  supabase: SupabaseClient,
  popId: string,
  chartAccountId: string,
  asOfDate: string,
): Promise<number> {
  const { data: accRow } = await supabase
    .from("accounting_chart_of_accounts")
    .select("nature")
    .eq("pop_id", popId)
    .eq("id", chartAccountId)
    .maybeSingle()
  if (!accRow) return 0
  const nature = String(accRow.nature ?? "deudora")
  const sums = await sumAccountLines(
    supabase,
    popId,
    chartAccountId,
    null,
    null,
    asOfDate,
  )
  if ("error" in sums) return 0
  return nature === "acreedora"
    ? roundMoney(sums.credit - sums.debit)
    : roundMoney(sums.debit - sums.credit)
}

export async function computeLedgerBalancesByAccountIds(
  supabase: SupabaseClient,
  popId: string,
  accountIds: string[],
): Promise<Map<string, number>> {
  const balances = new Map<string, number>()
  const unique = [...new Set(accountIds.filter(Boolean))]
  if (unique.length === 0) return balances

  const { data: accRows } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id, nature")
    .eq("pop_id", popId)
    .in("id", unique)
  const natureById = new Map<string, string>()
  for (const row of accRows || []) {
    natureById.set(String(row.id), String(row.nature ?? "deudora"))
  }
  for (const id of unique) balances.set(id, 0)

  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from("accounting_entry_lines")
      .select(
        `
        account_id,
        debit_amount,
        credit_amount,
        accounting_entries!inner ( pop_id, status )
      `,
      )
      .in("account_id", unique)
      .eq("accounting_entries.pop_id", popId)
      .eq("accounting_entries.status", "posted")
      .range(from, from + LINE_PAGE - 1)
    if (error) break
    const rows = data || []
    for (const row of rows) {
      const accountId = String(row.account_id)
      const nature = natureById.get(accountId) ?? "deudora"
      const debit = parseMoney(row.debit_amount)
      const credit = parseMoney(row.credit_amount)
      const prev = balances.get(accountId) ?? 0
      const delta = nature === "acreedora" ? credit - debit : debit - credit
      balances.set(accountId, roundMoney(prev + delta))
    }
    if (rows.length < LINE_PAGE) break
    from += LINE_PAGE
    if (from > 200_000) break
  }
  return balances
}

export async function computeChartAccountPeriodFlow(
  supabase: SupabaseClient,
  popId: string,
  chartAccountId: string,
  dateFrom: string | null,
  dateTo: string | null,
): Promise<{ in: number; out: number }> {
  if (!dateFrom && !dateTo) return { in: 0, out: 0 }
  const { data: accRow } = await supabase
    .from("accounting_chart_of_accounts")
    .select("nature")
    .eq("pop_id", popId)
    .eq("id", chartAccountId)
    .maybeSingle()
  if (!accRow) return { in: 0, out: 0 }
  const nature = String(accRow.nature ?? "deudora")
  const sums = await sumAccountLines(
    supabase,
    popId,
    chartAccountId,
    dateFrom,
    dateTo,
    null,
  )
  if ("error" in sums) return { in: 0, out: 0 }
  if (nature === "acreedora") {
    return { in: sums.credit, out: sums.debit }
  }
  return { in: sums.debit, out: sums.credit }
}
