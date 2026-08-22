import type { SupabaseClient } from "@supabase/supabase-js"
import {
  OPERATION_PAYMENT_KINDS,
  type OperationPaymentKind,
} from "../operations/paymentLabels.js"
import { resolveTreasuryAccountLedgerAccountId } from "../treasury/chart.js"

const PAYMENT_KIND_ACCOUNT_FALLBACK: Record<
  OperationPaymentKind,
  readonly string[]
> = {
  cash: ["1.1.1.01"],
  transfer: ["1.1.1.02", "1.1.1.04"],
  card_debit: ["1.1.1.03"],
  card_credit: ["1.1.1.03"],
  check: ["1.1.2.02", "2.1.1.02"],
  other: ["1.1.1.02", "1.1.1.04"],
}

function isValidOperationPaymentKind(
  kind: string,
): kind is OperationPaymentKind {
  return OPERATION_PAYMENT_KINDS.some((row) => row.value === kind)
}

export async function resolveAccountIdByCodes(
  supabase: SupabaseClient,
  popId: string,
  codes: readonly string[],
): Promise<string | null> {
  for (const code of codes) {
    const { data: row } = await supabase
      .from("accounting_chart_of_accounts")
      .select("id")
      .eq("pop_id", popId)
      .eq("code", code)
      .maybeSingle()
    if (row?.id) return String(row.id)
  }
  return null
}

export async function resolveLedgerAccountForTreasuryPayment(
  supabase: SupabaseClient,
  popId: string,
  paymentKind: string,
  treasuryAccountId: string | null | undefined,
): Promise<string | null> {
  const kind = isValidOperationPaymentKind(paymentKind) ? paymentKind : "other"
  const taId = treasuryAccountId?.trim() || null
  if (taId) {
    const fromTreasury = await resolveTreasuryAccountLedgerAccountId(
      supabase,
      popId,
      taId,
    )
    if (fromTreasury) return fromTreasury
  }
  return resolveAccountIdByCodes(
    supabase,
    popId,
    PAYMENT_KIND_ACCOUNT_FALLBACK[kind],
  )
}
