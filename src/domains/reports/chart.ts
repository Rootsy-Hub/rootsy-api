import type { SupabaseClient } from "@supabase/supabase-js"
import {
  ACCOUNT_TYPES,
  type AccountNature,
  type AccountType,
  type ChartAccountRow,
  type ChartAccountSearchRow,
  type ChartOfAccountsReportData,
  type ChartOfAccountsReportRow,
} from "./schema.js"
import { trialBalanceRowsForPopDateRange } from "./trialBalance.js"

const CHART_ACCOUNT_SEARCH_LIMIT = 12

function escapeChartAccountIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function buildChartAccountSearchOrClause(raw: string): string | null {
  const term = raw.trim().replace(/,/g, " ").trim()
  if (!term) return null
  const pattern = `%${escapeChartAccountIlikeToken(term)}%`
  return [`code.ilike.${pattern}`, `name.ilike.${pattern}`].join(",")
}

function resolveChartOfAccountsAsOf(asOfDate: string | null): string {
  const trimmed = asOfDate?.trim()
  if (trimmed) return trimmed
  return new Date().toISOString().slice(0, 10)
}

function parseAccountType(raw: unknown): AccountType {
  const value = String(raw ?? "")
  return ACCOUNT_TYPES.includes(value as AccountType)
    ? (value as AccountType)
    : "gastos"
}

function parseNature(raw: unknown): AccountNature {
  return String(raw ?? "") === "acreedora" ? "acreedora" : "deudora"
}

export async function searchChartAccounts(
  supabase: SupabaseClient,
  popId: string,
  query: string,
): Promise<
  | { success: true; accounts: ChartAccountSearchRow[] }
  | { success: false; error: string }
> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { success: true, accounts: [] }
  }
  const orClause = buildChartAccountSearchOrClause(trimmed)
  if (!orClause) {
    return { success: true, accounts: [] }
  }
  const { data, error } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id, code, name")
    .eq("pop_id", popId)
    .or(orClause)
    .order("code", { ascending: true })
    .limit(CHART_ACCOUNT_SEARCH_LIMIT)

  if (error) {
    return {
      success: false,
      error: error.message || "No se pudieron buscar cuentas.",
    }
  }

  return {
    success: true,
    accounts: (data || []).map((row) => ({
      id: String(row.id),
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
    })),
  }
}

async function loadChartAccountRowsForPop(
  supabase: SupabaseClient,
  popId: string,
): Promise<ChartAccountRow[] | { error: string }> {
  const { data: accRows, error: accErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select(
      "id, parent_id, code, name, account_type, nature, level, is_movement_account",
    )
    .eq("pop_id", popId)
    .order("code", { ascending: true })
  if (accErr) {
    return { error: accErr.message || "No se pudo cargar el plan de cuentas." }
  }

  return (accRows || []).map((row) => {
    const parentId = row.parent_id
    return {
      id: String(row.id),
      parentId:
        parentId != null && String(parentId).length > 0
          ? String(parentId)
          : null,
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      accountType: parseAccountType(row.account_type),
      nature: parseNature(row.nature),
      level: Number(row.level ?? 1) || 1,
      isMovementAccount: Boolean(row.is_movement_account),
    }
  })
}

export async function getChartOfAccountsReport(
  supabase: SupabaseClient,
  popId: string,
  asOfDate: string | null,
): Promise<
  | { success: true; data: ChartOfAccountsReportData }
  | { success: false; error: string }
> {
  const asOf = resolveChartOfAccountsAsOf(asOfDate)
  const accountsResult = await loadChartAccountRowsForPop(supabase, popId)
  if ("error" in accountsResult) {
    return { success: false, error: accountsResult.error }
  }

  const tb = await trialBalanceRowsForPopDateRange(supabase, popId, null, null, asOf)
  if (!tb.success) return tb

  const balanceByCode = new Map(
    tb.rows.map((row) => [row.accountCode, row.balance]),
  )

  const rows: ChartOfAccountsReportRow[] = accountsResult.map((account) => ({
    ...account,
    balance: balanceByCode.get(account.code) ?? 0,
  }))

  rows.sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  )

  return {
    success: true,
    data: { asOf, rows },
  }
}
