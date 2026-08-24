import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import {
  buildPosAcreditationLedgerOps,
  buildTreasurySettlementLedgerOps,
} from "./ledger.js"
import { parseTreasuryKind } from "./kinds.js"
import { computeChildPendingBalanceAsOf } from "./pending.js"
import type { PosAcreditationBody, SettlementBody } from "./schema.js"

export async function recordTreasurySettlement(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: SettlementBody,
  audit: MutationAuditCtx,
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

  const settlementId = randomUUID()
  const ledger = await buildTreasurySettlementLedgerOps(supabase, {
    popId,
    userId,
    settlementId,
    principal,
    adjustment,
    settledAt: input.settledAt,
    cardTreasuryAccountId: cardTaId,
    fundingTreasuryAccountId: fundTaId,
  })
  if (!ledger.success) {
    return { success: false, error: ledger.error, status: 500 }
  }

  const applied = await applyWithAudit(supabase, {
    kind: "treasury.settlement",
    ctx: audit,
    popId,
    resourceId: settlementId,
    previous: null,
    next: { id: settlementId, principal, adjustment },
    ops: [
      {
        op: "insert",
        table: "treasury_settlements",
        row: {
          id: settlementId,
          pop_id: popId,
          card_treasury_account_id: cardTaId,
          funding_treasury_account_id: fundTaId,
          amount: principal,
          principal_amount: principal,
          adjustment_amount: adjustment,
          settled_at: input.settledAt,
          notes: input.notes?.trim() || "",
          created_by: userId,
          accounting_entry_id: ledger.entryId,
        },
      },
      ...ledger.ops,
    ],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, id: settlementId }
}

export async function recordPosAcreditation(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  motherTreasuryAccountId: string,
  input: PosAcreditationBody,
  audit: MutationAuditCtx,
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

  const acreditationId = randomUUID()
  const ledger = await buildPosAcreditationLedgerOps(supabase, {
    popId,
    userId,
    acreditationId,
    principal,
    adjustment,
    creditedAt: input.creditedAt,
    notes: input.notes?.trim() || "",
    posTreasuryAccountId: posTaId,
    motherTreasuryAccountId: motherTaId,
  })
  if (!ledger.success) {
    return { success: false, error: ledger.error, status: 500 }
  }

  const applied = await applyWithAudit(supabase, {
    kind: "treasury.pos.acreditation",
    ctx: audit,
    popId,
    resourceId: acreditationId,
    previous: null,
    next: { id: acreditationId, principal, adjustment },
    ops: [
      {
        op: "insert",
        table: "treasury_pos_acreditations",
        row: {
          id: acreditationId,
          pop_id: popId,
          pos_treasury_account_id: posTaId,
          mother_treasury_account_id: motherTaId,
          principal_amount: principal,
          adjustment_amount: adjustment,
          credited_at: input.creditedAt,
          notes: input.notes?.trim() || "",
          created_by: userId,
          accounting_entry_id: ledger.entryId,
        },
      },
      ...ledger.ops,
    ],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  return {
    success: true,
    entryId: ledger.entryId,
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
