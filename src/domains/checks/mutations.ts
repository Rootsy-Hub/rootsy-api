import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import {
  buildCheckDepositLedgerOps,
  buildCheckLinkedReversalOps,
  buildCheckReceiveLedgerOps,
  buildCheckRejectLedgerOps,
  buildCheckVoidLedgerOps,
} from "./ledger.js"
import { isCheckDirection, isCheckStatus, lifecycleBlockedError, parseMoneyInput } from "./parse.js"
import type {
  CheckDirection,
  CheckStatus,
  ClearCheckBody,
  CreateCheckBody,
  DepositCheckBody,
  RejectCheckBody,
} from "./schema.js"
import { entryDateIsoInTimezone, timezoneForPopLedger } from "./timezone.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

type LoadedCheck = {
  checkId: string
  status: CheckStatus
  direction: CheckDirection
  amount: number
  checkNumber: string
  bankName: string
  depositTreasuryAccountId: string | null
  settlementAccountingEntryId: string | null
}

async function loadCheckForUpdate(
  supabase: SupabaseClient,
  popId: string,
  checkId: string,
): Promise<
  { ok: true; check: LoadedCheck } | { ok: false; error: string; status: 400 | 404 }
> {
  const { data, error } = await supabase
    .from("checks")
    .select(
      "id, status, direction, amount, check_number, bank_name, deposit_treasury_account_id, settlement_accounting_entry_id",
    )
    .eq("id", checkId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message, status: 400 }
  if (!data) return { ok: false, error: "No se encontró el cheque.", status: 404 }
  const status = isCheckStatus(String(data.status ?? ""))
    ? (data.status as CheckStatus)
    : null
  if (!status) {
    return { ok: false, error: "El estado del cheque no es válido.", status: 400 }
  }
  return {
    ok: true,
    check: {
      checkId: String(data.id),
      status,
      direction: isCheckDirection(String(data.direction ?? ""))
        ? (data.direction as CheckDirection)
        : "received",
      amount: Number(data.amount ?? 0) || 0,
      checkNumber: String(data.check_number ?? ""),
      bankName: String(data.bank_name ?? ""),
      depositTreasuryAccountId:
        data.deposit_treasury_account_id != null
          ? String(data.deposit_treasury_account_id)
          : null,
      settlementAccountingEntryId:
        data.settlement_accounting_entry_id != null
          ? String(data.settlement_accounting_entry_id)
          : null,
    },
  }
}

async function loadPopTimeZone(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
): Promise<string> {
  const { data } = await supabase
    .from("pops")
    .select("country")
    .eq("id", popId)
    .maybeSingle()
  return timezoneForPopLedger(
    data?.country != null ? String(data.country) : null,
    siteId,
  )
}

export async function createCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: CreateCheckBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const checkNumber = input.checkNumber.trim()
  if (!checkNumber) {
    return { success: false, error: "El número de cheque es obligatorio.", status: 400 }
  }
  const bankName = input.bankName.trim()
  if (!bankName) {
    return { success: false, error: "El banco es obligatorio.", status: 400 }
  }
  const amount = parseMoneyInput(input.amount)
  if (!(amount > 0)) {
    return {
      success: false,
      error: "El importe tiene que ser mayor a cero.",
      status: 400,
    }
  }
  const partyName = input.partyName.trim()
  const partyId = input.partyId.trim() || null
  const checkId = randomUUID()

  const posted = await buildCheckReceiveLedgerOps(supabase, {
    popId,
    userId,
    checkId,
    direction: input.direction,
    amount,
    entryDate: input.issueDate,
    checkNumber,
    bankName,
  })
  if (!posted.success) {
    return { success: false, error: posted.error, status: 400 }
  }

  const row = {
    id: checkId,
    pop_id: popId,
    direction: input.direction,
    check_number: checkNumber,
    bank_name: bankName,
    amount,
    issue_date: input.issueDate,
    due_date: input.dueDate,
    status: "in_portfolio",
    source_kind: "manual",
    client_id: input.direction === "received" ? partyId : null,
    supplier_id: input.direction === "issued" ? partyId : null,
    drawer_name: input.direction === "received" ? partyName || null : null,
    payee_name: input.direction === "issued" ? partyName || null : null,
    notes: input.notes.trim() || null,
    created_by: userId,
    received_accounting_entry_id: posted.entryId,
  }

  const applied = await applyWithAudit(supabase, {
    kind: "checks.create",
    ctx: audit,
    popId,
    resourceId: checkId,
    previous: null,
    next: row,
    ops: [{ op: "insert", table: "checks", row }, ...posted.ops],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function depositCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  checkId: string,
  input: DepositCheckBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "deposit")
  if (blocked) return { success: false, error: blocked, status: 409 }
  if (loaded.check.status !== "in_portfolio") {
    return { success: false, error: "El cheque ya no está en cartera.", status: 409 }
  }

  const treasuryAccountId = input.treasuryAccountId.trim()
  if (!treasuryAccountId) {
    return { success: false, error: "Elegí el banco o billetera.", status: 400 }
  }
  const { data: taRow, error: taErr } = await supabase
    .from("treasury_accounts")
    .select("id, kind")
    .eq("id", treasuryAccountId)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .maybeSingle()
  if (taErr) return { success: false, error: taErr.message, status: 500 }
  const kind = String(taRow?.kind ?? "")
  if (!taRow || (kind !== "bank" && kind !== "wallet")) {
    return {
      success: false,
      error: "Elegí una cuenta banco o billetera activa.",
      status: 400,
    }
  }

  const ops: AuditOp[] = []
  let settlementEntryId = loaded.check.settlementAccountingEntryId
  if (!settlementEntryId) {
    const posted = await buildCheckDepositLedgerOps(supabase, {
      popId,
      userId,
      checkId: loaded.check.checkId,
      direction: loaded.check.direction,
      amount: loaded.check.amount,
      entryDate: input.depositedAt,
      checkNumber: loaded.check.checkNumber,
      bankName: loaded.check.bankName,
      treasuryAccountId,
    })
    if (!posted.success) return { success: false, error: posted.error, status: 400 }
    settlementEntryId = posted.entryId
    ops.push(...posted.ops)
  }

  const patch = {
    status: "deposited",
    deposit_treasury_account_id: treasuryAccountId,
    deposited_at: input.depositedAt,
    settlement_accounting_entry_id: settlementEntryId,
  }
  ops.push({
    op: "update",
    table: "checks",
    id: loaded.check.checkId,
    row: patch,
  })

  const applied = await applyWithAudit(supabase, {
    kind: "checks.deposit",
    ctx: audit,
    popId,
    resourceId: loaded.check.checkId,
    previous: loaded.check,
    next: { ...loaded.check, ...patch },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function clearCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  checkId: string,
  input: ClearCheckBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "clear")
  if (blocked) return { success: false, error: blocked, status: 409 }
  if (loaded.check.status !== "deposited") {
    return { success: false, error: "El cheque ya no está depositado.", status: 409 }
  }

  const ops: AuditOp[] = []
  let settlementEntryId = loaded.check.settlementAccountingEntryId
  if (!settlementEntryId) {
    const treasuryAccountId = loaded.check.depositTreasuryAccountId
    if (!treasuryAccountId) {
      return {
        success: false,
        error: "Este cheque no tiene banco de depósito para registrar el asiento.",
        status: 400,
      }
    }
    const posted = await buildCheckDepositLedgerOps(supabase, {
      popId,
      userId,
      checkId: loaded.check.checkId,
      direction: loaded.check.direction,
      amount: loaded.check.amount,
      entryDate: input.clearedAt,
      checkNumber: loaded.check.checkNumber,
      bankName: loaded.check.bankName,
      treasuryAccountId,
    })
    if (!posted.success) return { success: false, error: posted.error, status: 400 }
    settlementEntryId = posted.entryId
    ops.push(...posted.ops)
  }

  const patch = {
    status: "cleared",
    cleared_at: input.clearedAt,
    settlement_accounting_entry_id: settlementEntryId,
  }
  ops.push({
    op: "update",
    table: "checks",
    id: loaded.check.checkId,
    row: patch,
  })

  const applied = await applyWithAudit(supabase, {
    kind: "checks.clear",
    ctx: audit,
    popId,
    resourceId: loaded.check.checkId,
    previous: loaded.check,
    next: { ...loaded.check, ...patch },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function rejectCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  checkId: string,
  input: RejectCheckBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "reject")
  if (blocked) return { success: false, error: blocked, status: 409 }

  const settledToBank = Boolean(loaded.check.settlementAccountingEntryId)
  const posted = await buildCheckRejectLedgerOps(supabase, {
    popId,
    userId,
    checkId: loaded.check.checkId,
    direction: loaded.check.direction,
    amount: loaded.check.amount,
    entryDate: input.rejectedAt,
    checkNumber: loaded.check.checkNumber,
    bankName: loaded.check.bankName,
    settledToBank,
    treasuryAccountId: loaded.check.depositTreasuryAccountId,
  })
  if (!posted.success) return { success: false, error: posted.error, status: 400 }

  const reversal = await buildCheckLinkedReversalOps(
    supabase,
    popId,
    loaded.check.checkId,
  )
  if (!reversal.success) return { success: false, error: reversal.error, status: 500 }

  const patch = {
    status: "rejected",
    rejected_at: input.rejectedAt,
    rejection_reason: input.reason.trim() || null,
  }
  const applied = await applyWithAudit(supabase, {
    kind: "checks.reject",
    ctx: audit,
    popId,
    resourceId: loaded.check.checkId,
    previous: loaded.check,
    next: { ...loaded.check, ...patch },
    ops: [
      ...posted.ops,
      {
        op: "update",
        table: "checks",
        id: loaded.check.checkId,
        row: patch,
      },
      ...reversal.ops,
    ],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function voidCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  siteId: string,
  checkId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "void")
  if (blocked) return { success: false, error: blocked, status: 409 }
  if (loaded.check.status !== "in_portfolio") {
    return {
      success: false,
      error: "Solo se puede anular un cheque en cartera.",
      status: 409,
    }
  }

  const timeZone = await loadPopTimeZone(supabase, popId, siteId)
  const posted = await buildCheckVoidLedgerOps(supabase, {
    popId,
    userId,
    checkId: loaded.check.checkId,
    direction: loaded.check.direction,
    amount: loaded.check.amount,
    entryDate: entryDateIsoInTimezone(timeZone),
    checkNumber: loaded.check.checkNumber,
    bankName: loaded.check.bankName,
  })
  if (!posted.success) return { success: false, error: posted.error, status: 400 }

  const reversal = await buildCheckLinkedReversalOps(
    supabase,
    popId,
    loaded.check.checkId,
  )
  if (!reversal.success) return { success: false, error: reversal.error, status: 500 }

  const applied = await applyWithAudit(supabase, {
    kind: "checks.void",
    ctx: audit,
    popId,
    resourceId: loaded.check.checkId,
    previous: loaded.check,
    next: { ...loaded.check, status: "voided" },
    ops: [
      ...posted.ops,
      {
        op: "update",
        table: "checks",
        id: loaded.check.checkId,
        row: { status: "voided" },
      },
      ...reversal.ops,
    ],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
