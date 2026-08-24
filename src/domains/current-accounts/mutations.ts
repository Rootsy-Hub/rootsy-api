import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import { auditedUpdate } from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import {
  currentAccountDocumentKindForDirection,
  currentAccountOpenAmount,
  normalizeCurrentAccountCreditLimit,
  normalizeCurrentAccountTermDays,
  roundMoney,
} from "./accounts.js"
import { loadOpenDocuments, loadPopTimeZone } from "./documents.js"
import type { ApplyCreditBody, EnrollmentBody } from "./schema.js"
import { loadUnappliedReceipts } from "./settle.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

export async function setCurrentAccountEnrollment(
  supabase: SupabaseClient,
  popId: string,
  input: EnrollmentBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const table = input.direction === "receivable" ? "clients" : "suppliers"
  const patch: Record<string, unknown> = {
    current_account_enabled: input.enabled,
  }
  if (input.enabled) {
    if (input.creditLimit !== undefined) {
      patch.current_account_credit_limit = normalizeCurrentAccountCreditLimit(
        input.creditLimit,
      )
    }
    if (input.termDays !== undefined) {
      patch.current_account_term_days = normalizeCurrentAccountTermDays(
        input.termDays,
      )
    }
  }

  const { data, error } = await supabase
    .from(table)
    .select("id, current_account_enabled, current_account_credit_limit, current_account_term_days")
    .eq("id", input.partyId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo actualizar la cuenta corriente.",
      status: 500,
    }
  }
  if (!data) {
    return {
      success: false,
      error:
        input.direction === "receivable"
          ? "No se encontró el cliente."
          : "No se encontró el proveedor.",
      status: 404,
    }
  }

  const applied = await auditedUpdate(supabase, {
    kind: "current_accounts.enrollment",
    table,
    id: input.partyId,
    row: patch,
    ctx: audit,
    popId,
    previous: data,
    next: { ...data, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function applyCurrentAccountCredit(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  input: ApplyCreditBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const requested = new Map<string, number>()
  for (const row of input.applications) {
    const amount = roundMoney(Number(row.amount ?? 0) || 0)
    if (amount <= 0.009) continue
    requested.set(row.documentId, roundMoney((requested.get(row.documentId) ?? 0) + amount))
  }
  if (requested.size === 0) {
    return { success: false, error: "Elegí al menos un comprobante.", status: 400 }
  }

  const timeZone = await loadPopTimeZone(supabase, popId, siteId)
  const documents = await loadOpenDocuments(
    supabase,
    popId,
    input.direction,
    timeZone,
    input.partyId,
  )
  const remainingById = new Map(documents.map((doc) => [doc.id, doc.remaining]))
  const leftovers = await loadUnappliedReceipts(
    supabase,
    popId,
    input.direction,
    input.partyId,
  )
  if (leftovers.length === 0) {
    return { success: false, error: "No hay saldo a cuenta para imputar.", status: 400 }
  }

  const planned: { receiptId: string; documentId: string; amount: number }[] = []
  const leftoverQueue = leftovers.map((row) => ({ ...row }))
  const kind = currentAccountDocumentKindForDirection(input.direction)

  for (const [documentId, asked] of requested) {
    const remaining = remainingById.get(documentId)
    if (remaining == null) {
      return {
        success: false,
        error: "Uno de los comprobantes ya no está abierto.",
        status: 409,
      }
    }
    let need = Math.min(asked, remaining)
    if (need <= 0.009) continue
    for (const receipt of leftoverQueue) {
      if (need <= 0.009) break
      if (receipt.leftover <= 0.009) continue
      const amount = Math.min(need, receipt.leftover)
      planned.push({ receiptId: receipt.id, documentId, amount: roundMoney(amount) })
      receipt.leftover = currentAccountOpenAmount(receipt.leftover, amount)
      need = currentAccountOpenAmount(need, amount)
    }
    if (need > 0.009) {
      return {
        success: false,
        error: "El saldo a cuenta no alcanza para imputar esos comprobantes.",
        status: 400,
      }
    }
  }

  if (planned.length === 0) {
    return { success: false, error: "No hay importes para imputar.", status: 400 }
  }

  const ops: AuditOp[] = planned.map((row) => ({
    op: "insert" as const,
    table: "current_account_applications",
    row: {
      id: randomUUID(),
      pop_id: popId,
      receipt_id: row.receiptId,
      document_kind: kind,
      document_id: row.documentId,
      amount: row.amount,
    },
  }))
  const applied = await applyWithAudit(supabase, {
    kind: "current_accounts.apply",
    ctx: audit,
    popId,
    resourceId: input.partyId,
    previous: null,
    next: { applications: planned.length },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
