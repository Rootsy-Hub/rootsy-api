import type { SupabaseClient } from "@supabase/supabase-js"
import { roundMoney } from "./money.js"
import {
  type AccountType,
  type BalanceSheetResult,
  type BalanceSheetSection,
  type BalanceSheetSectionRow,
  type CashFlowRow,
  type FinancialSummaryRow,
  type IncomeStatementLine,
  type IncomeStatementResult,
  type VatPositionRow,
} from "./schema.js"
import { trialBalanceRowsForPopDateRange } from "./trialBalance.js"

function isCashEquivalentAccountCode(code: string): boolean {
  return code.trim().startsWith("1.1.1.")
}

function isVatRelatedAccountCode(code: string): boolean {
  const c = code.trim()
  return c.startsWith("1.1.2.") || c.startsWith("2.1.2.")
}

async function treasuryEntityNameByChartCode(
  supabase: SupabaseClient,
  popId: string,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("treasury_accounts")
    .select(
      `
      parent_treasury_account_id,
      accounting_chart_of_accounts ( code )
    `,
    )
    .eq("pop_id", popId)
    .not("parent_treasury_account_id", "is", null)

  if (error || !data?.length) return new Map()

  const parentIds = [
    ...new Set(
      data
        .map((row) =>
          row.parent_treasury_account_id != null
            ? String(row.parent_treasury_account_id)
            : null,
        )
        .filter((id): id is string => Boolean(id)),
    ),
  ]

  const parentNames = new Map<string, string>()
  if (parentIds.length > 0) {
    const { data: parents } = await supabase
      .from("treasury_accounts")
      .select("id, name")
      .eq("pop_id", popId)
      .in("id", parentIds)
    for (const parent of parents || []) {
      if (parent.id) {
        parentNames.set(String(parent.id), String(parent.name ?? "").trim())
      }
    }
  }

  const out = new Map<string, string>()
  for (const row of data) {
    const chart = row.accounting_chart_of_accounts as unknown as {
      code?: string
    } | null
    const code = chart?.code?.trim()
    const parentId =
      row.parent_treasury_account_id != null
        ? String(row.parent_treasury_account_id)
        : null
    if (!code || !parentId) continue
    const entityName = parentNames.get(parentId)
    if (entityName) out.set(code, entityName)
  }
  return out
}

export async function getTrialBalance(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
) {
  return trialBalanceRowsForPopDateRange(supabase, popId, fromDate, toDate, null)
}

export async function getBalanceSheet(
  supabase: SupabaseClient,
  popId: string,
  asOfDate: string | null,
): Promise<
  | { success: true; data: BalanceSheetResult }
  | { success: false; error: string }
> {
  const d = asOfDate?.trim()
  if (!d) {
    return { success: false, error: "Indicá la fecha de corte del balance." }
  }
  const tb = await trialBalanceRowsForPopDateRange(supabase, popId, null, null, d)
  if (!tb.success) return tb
  const rows = tb.rows
  const isActivo = (t: AccountType) =>
    t === "activo_corriente" || t === "activo_no_corriente"
  const isPasivo = (t: AccountType) =>
    t === "pasivo_corriente" || t === "pasivo_no_corriente"
  const sumBal = (pred: (t: AccountType) => boolean) =>
    roundMoney(rows.filter((r) => pred(r.accountType)).reduce((a, r) => a + r.balance, 0))
  const linesFor = (pred: (t: AccountType) => boolean): BalanceSheetSectionRow[] =>
    rows
      .filter((r) => pred(r.accountType))
      .map((r) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        balance: r.balance,
      }))
  const totalIngresos = sumBal((t) => t === "ingresos")
  const totalCostos = sumBal((t) => t === "costos")
  const totalGastos = sumBal((t) => t === "gastos")
  const resultadoAcumulado = roundMoney(totalIngresos - totalCostos - totalGastos)
  const totalActivo = sumBal(isActivo)
  const totalPasivo = sumBal(isPasivo)
  const totalPatrimonioCuentas = sumBal((t) => t === "patrimonio_neto")
  const totalPasivoPatrimonioYResultado = roundMoney(
    totalPasivo + totalPatrimonioCuentas + resultadoAcumulado,
  )
  const diferenciaCuadre = roundMoney(
    totalActivo - totalPasivoPatrimonioYResultado,
  )
  const sections: BalanceSheetSection[] = [
    {
      key: "activo",
      title: "Activo",
      rows: linesFor(isActivo),
      sectionTotal: totalActivo,
    },
    {
      key: "pasivo",
      title: "Pasivo",
      rows: linesFor(isPasivo),
      sectionTotal: totalPasivo,
    },
    {
      key: "patrimonio",
      title: "Patrimonio neto",
      rows: [
        ...linesFor((t) => t === "patrimonio_neto"),
        {
          accountCode: "—",
          accountName: "Resultado acumulado (cuentas de resultado)",
          balance: resultadoAcumulado,
        },
      ],
      sectionTotal: roundMoney(totalPatrimonioCuentas + resultadoAcumulado),
    },
  ]
  return {
    success: true,
    data: {
      asOf: d,
      sections,
      resultadoAcumulado,
      totalActivo,
      totalPasivo,
      totalPatrimonioCuentas,
      totalPasivoPatrimonioYResultado,
      diferenciaCuadre,
    },
  }
}

export async function getIncomeStatement(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
): Promise<
  | { success: true; data: IncomeStatementResult }
  | { success: false; error: string }
> {
  const tb = await trialBalanceRowsForPopDateRange(
    supabase,
    popId,
    fromDate,
    toDate,
    null,
  )
  if (!tb.success) return tb
  const rows = tb.rows
  const pick = (t: AccountType): IncomeStatementLine[] =>
    rows
      .filter((r) => r.accountType === t)
      .map((r) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        accountType: r.accountType,
        balance: r.balance,
      }))
  const ingresos = pick("ingresos")
  const costos = pick("costos")
  const gastos = pick("gastos")
  const totalIngresos = roundMoney(ingresos.reduce((a, r) => a + r.balance, 0))
  const totalCostos = roundMoney(costos.reduce((a, r) => a + r.balance, 0))
  const totalGastos = roundMoney(gastos.reduce((a, r) => a + r.balance, 0))
  const resultadoNeto = roundMoney(totalIngresos - totalCostos - totalGastos)
  return {
    success: true,
    data: {
      from: fromDate?.trim() ?? "",
      to: toDate?.trim() ?? "",
      ingresos,
      costos,
      gastos,
      totalIngresos,
      totalCostos,
      totalGastos,
      resultadoNeto,
    },
  }
}

export async function getCashFlow(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
): Promise<
  { success: true; rows: CashFlowRow[] } | { success: false; error: string }
> {
  const tb = await trialBalanceRowsForPopDateRange(
    supabase,
    popId,
    fromDate,
    toDate,
    null,
  )
  if (!tb.success) return tb
  const entityByChartCode = await treasuryEntityNameByChartCode(supabase, popId)
  const rows: CashFlowRow[] = tb.rows
    .filter((r) => isCashEquivalentAccountCode(r.accountCode))
    .map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      entityName: entityByChartCode.get(r.accountCode.trim()) ?? null,
      entradas: r.sumDebit,
      salidas: r.sumCredit,
      neto: r.balance,
    }))
  return { success: true, rows }
}

export async function getVatPosition(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
): Promise<
  { success: true; rows: VatPositionRow[] } | { success: false; error: string }
> {
  const tb = await trialBalanceRowsForPopDateRange(
    supabase,
    popId,
    fromDate,
    toDate,
    null,
  )
  if (!tb.success) return tb
  const rows: VatPositionRow[] = tb.rows
    .filter((r) => isVatRelatedAccountCode(r.accountCode))
    .map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      accountType: r.accountType,
      sumDebit: r.sumDebit,
      sumCredit: r.sumCredit,
      balance: r.balance,
    }))
  return { success: true, rows }
}

export async function getFinancialSummaries(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
): Promise<
  | { success: true; summaries: FinancialSummaryRow[] }
  | { success: false; error: string }
> {
  const tb = await getTrialBalance(supabase, popId, fromDate, toDate)
  if (!tb.success) return tb
  const sum = (types: AccountType[]) =>
    roundMoney(
      tb.rows
        .filter((r) => types.includes(r.accountType))
        .reduce((a, r) => a + r.balance, 0),
    )
  const summaries: FinancialSummaryRow[] = [
    {
      label: "Activo (total)",
      total: sum(["activo_corriente", "activo_no_corriente"]),
      accountTypes: ["activo_corriente", "activo_no_corriente"],
    },
    {
      label: "Pasivo (total)",
      total: sum(["pasivo_corriente", "pasivo_no_corriente"]),
      accountTypes: ["pasivo_corriente", "pasivo_no_corriente"],
    },
    {
      label: "Patrimonio neto (total)",
      total: sum(["patrimonio_neto"]),
      accountTypes: ["patrimonio_neto"],
    },
    {
      label: "Ingresos (total)",
      total: sum(["ingresos"]),
      accountTypes: ["ingresos"],
    },
    {
      label: "Costos (total)",
      total: sum(["costos"]),
      accountTypes: ["costos"],
    },
    {
      label: "Gastos (total)",
      total: sum(["gastos"]),
      accountTypes: ["gastos"],
    },
  ]
  return { success: true, summaries }
}
