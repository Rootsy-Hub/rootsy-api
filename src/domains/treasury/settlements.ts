import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { postPosAcreditationLedger, postTreasurySettlementLedger } from "./ledger.js"
import { parseTreasuryKind } from "./kinds.js"
import { computeChildPendingBalanceAsOf } from "./pending.js"
import type { PosAcreditationBody, SettlementBody } from "./schema.js"

export async function recordTreasurySettlement(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: SettlementBody,
): Promise<
  | { success: true; id: string }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const cardTaId = input.cardTreasuryAccountId
  const fundTaId = input.fundingTreasuryAccountId
  const principal = roundMoney(parseMoney(input.principalAmount))
  const adjustment = roundMoney(parseMoney(input.adjustmentAmount ?? 0))

  if (cardTaId === fundTaId) {
    return {
      success: false,
      error: "La cuenta de pago debe ser distinta de la tarjeta.",
      status: 400,
    }
  }

  const { data: cardTa, error: cardTaErr } = await supabase
    .from("treasury_accounts")
    .select("id, kind")
    .eq("id", cardTaId)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .maybeSingle()
  if (cardTaErr || !cardTa?.id) {
    return { success: false, error: "Tarjeta corporativa inválida.", status: 400 }
  }
  if (parseTreasuryKind(cardTa.kind) !== "card_payable") {
    return {
      success: false,
      error: "La cuenta seleccionada no es una tarjeta corporativa.",
      status: 400,
    }
  }

  const { data: fundTa, error: fundTaErr } = await supabase
    .from("treasury_accounts")
    .select("id, kind")
    .eq("id", fundTaId)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .maybeSingle()
  if (fundTaErr || !fundTa?.id) {
    return { success: false, error: "Cuenta de fondeo inválida.", status: 400 }
  }
  if (parseTreasuryKind(fundTa.kind) === "card_payable") {
    return {
      success: false,
      error: "Pagá el resumen desde banco, efectivo o billetera.",
      status: 400,
    }
  }

  const outstanding = await computeChildPendingBalanceAsOf(
    supabase,
    popId,
    cardTaId,
    "card_payable",
    input.settledAt,
  )
  if (principal > outstanding + 0.0001) {
    return {
      success: false,
      error: `Los consumos a cancelar superan la deuda pendiente al ${input.settledAt} (${outstanding.toFixed(2)}).`,
      status: 400,
    }
  }

  const { data: ins, error: insErr } = await supabase
    .from("treasury_settlements")
    .insert({
      pop_id: popId,
      card_treasury_account_id: cardTaId,
      funding_treasury_account_id: fundTaId,
      amount: principal,
      principal_amount: principal,
      adjustment_amount: adjustment,
      settled_at: input.settledAt,
      notes: input.notes?.trim() || "",
      created_by: userId,
    })
    .select("id")
    .single()
  if (insErr || !ins?.id) {
    return {
      success: false,
      error: insErr?.message || "No se pudo registrar la liquidación.",
      status: 500,
    }
  }
  const settlementId = String(ins.id)

  const ledger = await postTreasurySettlementLedger(supabase, {
    popId,
    userId,
    settlementId,
  })
  if (!ledger.success) {
    await supabase
      .from("treasury_settlements")
      .delete()
      .eq("id", settlementId)
      .eq("pop_id", popId)
    return { success: false, error: ledger.error, status: 500 }
  }
  return { success: true, id: settlementId }
}

export async function recordPosAcreditation(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  motherTreasuryAccountId: string,
  input: PosAcreditationBody,
): Promise<
  | { success: true; entryId: string }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const posTaId = input.posTreasuryAccountId
  const motherTaId = input.motherTreasuryAccountId?.trim() || motherTreasuryAccountId
  const principal = roundMoney(parseMoney(input.principalAmount))
  const adjustment = roundMoney(parseMoney(input.adjustmentAmount ?? 0))

  const { data: posTa, error: posErr } = await supabase
    .from("treasury_accounts")
    .select("id, name, parent_treasury_account_id, kind")
    .eq("id", posTaId)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .maybeSingle()
  if (posErr || !posTa?.id) {
    return { success: false, error: "Terminal POS no encontrado.", status: 404 }
  }
  if (String(posTa.parent_treasury_account_id ?? "") !== motherTaId) {
    return {
      success: false,
      error: "El terminal no pertenece a esta cuenta madre.",
      status: 400,
    }
  }

  const posBalance = await computeChildPendingBalanceAsOf(
    supabase,
    popId,
    posTaId,
    "pos",
    input.creditedAt,
  )
  const totalSettlement = roundMoney(principal + adjustment)
  if (totalSettlement > posBalance + 0.0001) {
    return {
      success: false,
      error: `El total supera el saldo a liquidar al ${input.creditedAt} (${posBalance.toFixed(2)}).`,
      status: 400,
    }
  }

  const { data: ins, error: insErr } = await supabase
    .from("treasury_pos_acreditations")
    .insert({
      pop_id: popId,
      pos_treasury_account_id: posTaId,
      mother_treasury_account_id: motherTaId,
      principal_amount: principal,
      adjustment_amount: adjustment,
      credited_at: input.creditedAt,
      notes: input.notes?.trim() || "",
      created_by: userId,
    })
    .select("id")
    .single()
  if (insErr || !ins?.id) {
    return {
      success: false,
      error: insErr?.message || "No se pudo registrar la acreditación.",
      status: 500,
    }
  }
  const acreditationId = String(ins.id)

  const ledger = await postPosAcreditationLedger(supabase, {
    popId,
    userId,
    acreditationId,
  })
  if (!ledger.success) {
    await supabase
      .from("treasury_pos_acreditations")
      .delete()
      .eq("id", acreditationId)
      .eq("pop_id", popId)
    return { success: false, error: ledger.error, status: 500 }
  }

  const { data: linked } = await supabase
    .from("treasury_pos_acreditations")
    .select("accounting_entry_id")
    .eq("id", acreditationId)
    .eq("pop_id", popId)
    .maybeSingle()

  return {
    success: true,
    entryId: String(linked?.accounting_entry_id ?? acreditationId),
  }
}

export async function getChildPendingBalance(
  supabase: SupabaseClient,
  popId: string,
  childTreasuryAccountId: string,
  childRole: "pos" | "card_payable",
  asOfDate: string,
): Promise<{ success: true; balance: number }> {
  const balance = await computeChildPendingBalanceAsOf(
    supabase,
    popId,
    childTreasuryAccountId,
    childRole,
    asOfDate,
  )
  return { success: true, balance }
}
