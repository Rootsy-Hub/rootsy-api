import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "./money.js"
import {
  ACCOUNT_TYPES,
  type AccountNature,
  type AccountType,
  type TrialBalanceRow,
} from "./schema.js"

const LINE_PAGE = 1000

function parseAccountType(raw: unknown): AccountType {
  const value = String(raw ?? "gastos")
  return ACCOUNT_TYPES.includes(value as AccountType)
    ? (value as AccountType)
    : "gastos"
}

function parseNature(raw: unknown): AccountNature {
  return String(raw ?? "deudora") === "acreedora" ? "acreedora" : "deudora"
}

export async function trialBalanceRowsForPopDateRange(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
  throughDateOnly: string | null,
): Promise<
  { success: true; rows: TrialBalanceRow[] } | { success: false; error: string }
> {
  const agg = new Map<
    string,
    {
      code: string
      name: string
      accountType: AccountType
      nature: AccountNature
      debit: number
      credit: number
    }
  >()

  let from = 0
  while (true) {
    let q = supabase
      .from("accounting_entry_lines")
      .select(
        `
        account_id,
        debit_amount,
        credit_amount,
        accounting_chart_of_accounts ( code, name, account_type, nature ),
        accounting_entries!inner ( pop_id, status, entry_date )
      `,
      )
      .eq("accounting_entries.pop_id", popId)
      .eq("accounting_entries.status", "posted")
      .range(from, from + LINE_PAGE - 1)

    if (throughDateOnly && throughDateOnly.trim()) {
      q = q.lte("accounting_entries.entry_date", throughDateOnly.trim())
    } else {
      if (fromDate && fromDate.trim()) {
        q = q.gte("accounting_entries.entry_date", fromDate.trim())
      }
      if (toDate && toDate.trim()) {
        q = q.lte("accounting_entries.entry_date", toDate.trim())
      }
    }

    const { data, error } = await q
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudieron cargar las líneas.",
      }
    }

    const rows = data || []
    for (const ln of rows) {
      const acc = ln.accounting_chart_of_accounts as unknown as {
        code?: string
        name?: string
        account_type?: string
        nature?: string
      } | null
      const aid = String(ln.account_id)
      const prev = agg.get(aid) ?? {
        code: acc?.code ? String(acc.code) : "",
        name: acc?.name ? String(acc.name) : "",
        accountType: parseAccountType(acc?.account_type),
        nature: parseNature(acc?.nature),
        debit: 0,
        credit: 0,
      }
      prev.debit += parseMoney(ln.debit_amount)
      prev.credit += parseMoney(ln.credit_amount)
      agg.set(aid, prev)
    }

    if (rows.length < LINE_PAGE) break
    from += LINE_PAGE
    if (from > 500_000) break
  }

  const rows: TrialBalanceRow[] = [...agg.values()]
    .map((v) => {
      const balance =
        v.nature === "deudora"
          ? roundMoney(v.debit - v.credit)
          : roundMoney(v.credit - v.debit)
      return {
        accountCode: v.code,
        accountName: v.name,
        accountType: v.accountType,
        sumDebit: roundMoney(v.debit),
        sumCredit: roundMoney(v.credit),
        balance,
      }
    })
    .sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode, undefined, { numeric: true }),
    )

  return { success: true, rows }
}
