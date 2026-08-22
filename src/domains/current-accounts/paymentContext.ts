import type { SupabaseClient } from "@supabase/supabase-js"
import type { TreasuryPaymentContext } from "./schema.js"

const TREASURY_MOTHER_CHART_PREFIXES = [
  "1.1.1.01.",
  "1.1.1.02.",
  "1.1.1.04.",
] as const

function isMotherTreasuryAccount(chartAccountCode: string): boolean {
  const code = chartAccountCode.trim()
  if (!code) return false
  return TREASURY_MOTHER_CHART_PREFIXES.some((prefix) => code.startsWith(prefix))
}

function isSettlementReceivableChartCode(chartAccountCode: string): boolean {
  const code = chartAccountCode.trim()
  return code.startsWith("1.1.1.03.") && code !== "1.1.1.03"
}

export async function loadCurrentAccountPaymentContext(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: TreasuryPaymentContext }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("treasury_accounts")
    .select(
      `
        id,
        name,
        kind,
        is_active,
        sort_order,
        accounting_chart_of_accounts ( code )
      `,
    )
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })

  if (error) {
    return {
      success: false,
      error: error.message || "No se pudieron cargar cuentas.",
    }
  }

  let defaultCashTreasuryAccountId: string | null = null
  let checkReceivableTreasuryAccountId: string | null = null
  let checkPayableTreasuryAccountId: string | null = null
  const cashTreasuryAccounts: TreasuryPaymentContext["cashTreasuryAccounts"] = []
  const bankTreasuryAccounts: TreasuryPaymentContext["bankTreasuryAccounts"] = []
  const posTreasuryAccounts: TreasuryPaymentContext["posTreasuryAccounts"] = []
  const payTreasuryAccounts: TreasuryPaymentContext["payTreasuryAccounts"] = []

  for (const row of data || []) {
    const id = String(row.id)
    const name = String(row.name ?? "")
    const kind = String(row.kind ?? "")
    const chart = row.accounting_chart_of_accounts as unknown as {
      code?: string
    } | null
    const code = String(chart?.code ?? "")

    if (kind === "check_receivable") {
      if (!checkReceivableTreasuryAccountId) {
        checkReceivableTreasuryAccountId = id
      }
      continue
    }

    if (kind === "check_payable") {
      if (!checkPayableTreasuryAccountId) {
        checkPayableTreasuryAccountId = id
      }
      continue
    }

    if (kind === "card_payable") {
      payTreasuryAccounts.push({ id, name })
      continue
    }

    if (isSettlementReceivableChartCode(code)) {
      posTreasuryAccounts.push({ id, name })
      continue
    }

    if (!isMotherTreasuryAccount(code)) continue

    if (kind === "cash") {
      cashTreasuryAccounts.push({ id, name })
      if (!defaultCashTreasuryAccountId) {
        defaultCashTreasuryAccountId = id
      }
    } else if (kind === "bank" || kind === "wallet") {
      bankTreasuryAccounts.push({ id, name })
    }
  }

  return {
    success: true,
    data: {
      defaultCashTreasuryAccountId,
      cashTreasuryAccounts,
      bankTreasuryAccounts,
      posTreasuryAccounts,
      payTreasuryAccounts,
      checkReceivableTreasuryAccountId,
      checkPayableTreasuryAccountId,
    },
  }
}
