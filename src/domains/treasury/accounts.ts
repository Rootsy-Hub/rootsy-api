import type { SupabaseClient } from "@supabase/supabase-js"
import {
  isCardPayableChartCode,
  isMotherTreasuryAccount,
  isSettlementReceivableChartCode,
  parseTreasuryKind,
  type TreasuryAccountKind,
} from "./kinds.js"
import type { TreasuryMercadoPagoConnection } from "./schema.js"

export type RawTreasuryAccount = {
  id: string
  name: string
  kind: TreasuryAccountKind
  brandKey: string | null
  isSystemDefault: boolean
  isActive: boolean
  sortOrder: number
  chartAccountId: string
  chartAccountCode: string
  chartAccountName: string
  parentTreasuryAccountId: string | null
}

export async function loadAllTreasuryAccounts(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  { success: true; rows: RawTreasuryAccount[] } | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("treasury_accounts")
    .select(
      `
      id,
      name,
      kind,
      is_system_default,
      is_active,
      sort_order,
      brand_key,
      parent_treasury_account_id,
      accounting_chart_account_id,
      accounting_chart_of_accounts ( code, name )
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

  const rows: RawTreasuryAccount[] = (data || []).map((row) => {
    const chart = row.accounting_chart_of_accounts as unknown as {
      code?: string
      name?: string
    } | null
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      kind: parseTreasuryKind(row.kind),
      brandKey: row.brand_key != null ? String(row.brand_key) : null,
      isSystemDefault: Boolean(row.is_system_default),
      isActive: Boolean(row.is_active),
      sortOrder: Number(row.sort_order ?? 0),
      chartAccountId: String(row.accounting_chart_account_id),
      chartAccountCode: String(chart?.code ?? ""),
      chartAccountName: String(chart?.name ?? ""),
      parentTreasuryAccountId:
        row.parent_treasury_account_id != null
          ? String(row.parent_treasury_account_id)
          : null,
    }
  })
  return { success: true, rows }
}

export function accountingAccountLabel(row: RawTreasuryAccount): string {
  return `${row.chartAccountCode} ${row.chartAccountName}`.trim()
}

export function childRoleOf(row: RawTreasuryAccount): "pos" | "card_payable" {
  return row.kind === "card_payable" || isCardPayableChartCode(row.chartAccountCode)
    ? "card_payable"
    : "pos"
}

export function integrationFlagsForMother(
  motherId: string,
  allRows: RawTreasuryAccount[],
): { hasPosIntegration: boolean; hasCardIntegration: boolean } {
  let hasPosIntegration = false
  let hasCardIntegration = false
  for (const row of allRows) {
    if (row.parentTreasuryAccountId !== motherId) continue
    if (isSettlementReceivableChartCode(row.chartAccountCode)) {
      hasPosIntegration = true
    }
    if (
      isCardPayableChartCode(row.chartAccountCode) ||
      row.kind === "card_payable"
    ) {
      hasCardIntegration = true
    }
  }
  return { hasPosIntegration, hasCardIntegration }
}

export function toListRow(
  row: RawTreasuryAccount,
  flags?: { hasPosIntegration: boolean; hasCardIntegration: boolean },
) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    brandKey: row.brandKey,
    isSystemDefault: row.isSystemDefault,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    accountingAccountId: row.chartAccountId,
    accountingAccountLabel: accountingAccountLabel(row),
    chartAccountCode: row.chartAccountCode,
    isCardPayable: row.kind === "card_payable",
    hasPosIntegration: flags?.hasPosIntegration ?? false,
    hasCardIntegration: flags?.hasCardIntegration ?? false,
  }
}

export function isMotherRow(row: RawTreasuryAccount): boolean {
  return isMotherTreasuryAccount(row.chartAccountCode)
}

export async function loadMercadoPagoConnection(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
): Promise<TreasuryMercadoPagoConnection | null> {
  const { data, error } = await supabase
    .from("pop_mercadopago_connections")
    .select(
      "id, treasury_account_id, status, mp_user_id, mp_email, connected_at, disconnected_at",
    )
    .eq("pop_id", popId)
    .eq("treasury_account_id", treasuryAccountId)
    .maybeSingle()
  if (error || !data?.id) return null
  const statusRaw = String(data.status ?? "disconnected")
  const status =
    statusRaw === "connected" || statusRaw === "expired"
      ? statusRaw
      : "disconnected"
  return {
    id: String(data.id),
    treasuryAccountId: String(data.treasury_account_id ?? treasuryAccountId),
    status,
    mpUserId: data.mp_user_id != null ? String(data.mp_user_id) : null,
    mpEmail: data.mp_email != null ? String(data.mp_email) : null,
    connectedAt: data.connected_at != null ? String(data.connected_at) : null,
    disconnectedAt:
      data.disconnected_at != null ? String(data.disconnected_at) : null,
  }
}
