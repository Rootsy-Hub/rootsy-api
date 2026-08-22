import type { SupabaseClient } from "@supabase/supabase-js"
import {
  childRoleOf,
  integrationFlagsForMother,
  isMotherRow,
  loadAllTreasuryAccounts,
  loadMercadoPagoConnection,
  toListRow,
} from "./accounts.js"
import { compareTreasuryChartAccountCodes } from "./kinds.js"
import type {
  TreasuryAccountListRow,
  TreasuryAccountPageData,
  TreasuryChildAccountRow,
  TreasuryFundingOption,
} from "./schema.js"

export async function listTreasuryAccounts(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | {
      success: true
      data: {
        rows: TreasuryAccountListRow[]
        fundingAccounts: TreasuryFundingOption[]
      }
    }
  | { success: false; error: string }
> {
  const loaded = await loadAllTreasuryAccounts(supabase, popId)
  if (!loaded.success) return loaded

  const rows = loaded.rows
    .filter(isMotherRow)
    .map((row) => toListRow(row, integrationFlagsForMother(row.id, loaded.rows)))
    .sort((a, b) =>
      compareTreasuryChartAccountCodes(a.chartAccountCode, b.chartAccountCode),
    )

  const fundingAccounts = loaded.rows
    .filter(
      (row) =>
        row.isActive &&
        row.kind !== "card_payable" &&
        isMotherRow(row),
    )
    .sort((a, b) =>
      compareTreasuryChartAccountCodes(a.chartAccountCode, b.chartAccountCode),
    )
    .map((row) => ({ id: row.id, name: row.name, kind: row.kind }))

  return { success: true, data: { rows, fundingAccounts } }
}

export async function getTreasuryAccountPage(
  supabase: SupabaseClient,
  popId: string,
  accountId: string,
): Promise<
  | { success: true; data: TreasuryAccountPageData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const loaded = await loadAllTreasuryAccounts(supabase, popId)
  if (!loaded.success) return { ...loaded, status: 500 }

  const row = loaded.rows.find((item) => item.id === accountId)
  if (!row) {
    return { success: false, error: "Cuenta no encontrada.", status: 404 }
  }

  const fundingAccounts = loaded.rows
    .filter(
      (item) =>
        item.isActive &&
        item.kind !== "card_payable" &&
        isMotherRow(item),
    )
    .sort((a, b) =>
      compareTreasuryChartAccountCodes(a.chartAccountCode, b.chartAccountCode),
    )
    .map((item) => ({ id: item.id, name: item.name, kind: item.kind }))

  const isMother = isMotherRow(row)
  const children: TreasuryChildAccountRow[] = isMother
    ? loaded.rows
        .filter((item) => item.parentTreasuryAccountId === row.id)
        .sort((a, b) => a.name.localeCompare(b.name, "es"))
        .map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          chartAccountCode: item.chartAccountCode,
          childRole: childRoleOf(item),
          ledgerBalance: null,
          outstandingBalance: 0,
          settledTotal: 0,
        }))
    : []

  let parentAccount: { id: string; name: string } | null = null
  if (row.parentTreasuryAccountId) {
    const parent = loaded.rows.find(
      (item) => item.id === row.parentTreasuryAccountId,
    )
    if (parent) parentAccount = { id: parent.id, name: parent.name }
  }

  return {
    success: true,
    data: {
      account: toListRow(
        row,
        isMother ? integrationFlagsForMother(row.id, loaded.rows) : undefined,
      ),
      children,
      isMother,
      parentAccount,
      fundingAccounts,
      mercadopagoConnection: await loadMercadoPagoConnection(
        supabase,
        popId,
        row.id,
      ),
    },
  }
}
