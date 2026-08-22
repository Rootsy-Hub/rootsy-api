import type { SupabaseClient } from "@supabase/supabase-js"
import {
  cancelCheckAccountingEntry,
  postCheckDepositLedger,
  postCheckReceiveLedger,
  postCheckRejectLedger,
  postCheckVoidLedger,
  reversePaymentsLinkedToCheck,
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

  const { data, error } = await supabase
    .from("checks")
    .insert({
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
    })
    .select("id")
    .single()
  if (error || !data?.id) {
    return {
      success: false,
      error: error?.message || "No se pudo crear el cheque.",
      status: 500,
    }
  }
  const checkId = String(data.id)
  const posted = await postCheckReceiveLedger(supabase, {
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
    await supabase.from("checks").delete().eq("id", checkId).eq("pop_id", popId)
    return { success: false, error: posted.error, status: 400 }
  }
  const { error: linkErr } = await supabase
    .from("checks")
    .update({ received_accounting_entry_id: posted.entryId })
    .eq("id", checkId)
    .eq("pop_id", popId)
  if (linkErr) {
    await cancelCheckAccountingEntry(supabase, posted.entryId)
    await supabase.from("checks").delete().eq("id", checkId).eq("pop_id", popId)
    return {
      success: false,
      error: linkErr.message || "No se pudo vincular el asiento al cheque.",
      status: 500,
    }
  }
  return { success: true }
}

export async function depositCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  checkId: string,
  input: DepositCheckBody,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "deposit")
  if (blocked) return { success: false, error: blocked, status: 409 }

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

  let settlementEntryId = loaded.check.settlementAccountingEntryId
  if (!settlementEntryId) {
    const posted = await postCheckDepositLedger(supabase, {
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
  }

  const { data, error } = await supabase
    .from("checks")
    .update({
      status: "deposited",
      deposit_treasury_account_id: treasuryAccountId,
      deposited_at: input.depositedAt,
      settlement_accounting_entry_id: settlementEntryId,
    })
    .eq("id", loaded.check.checkId)
    .eq("pop_id", popId)
    .eq("status", "in_portfolio")
    .select("id")
    .maybeSingle()
  if (error) {
    if (!loaded.check.settlementAccountingEntryId && settlementEntryId) {
      await cancelCheckAccountingEntry(supabase, settlementEntryId)
    }
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    if (!loaded.check.settlementAccountingEntryId && settlementEntryId) {
      await cancelCheckAccountingEntry(supabase, settlementEntryId)
    }
    return { success: false, error: "El cheque ya no está en cartera.", status: 409 }
  }
  return { success: true }
}

export async function clearCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  checkId: string,
  input: ClearCheckBody,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "clear")
  if (blocked) return { success: false, error: blocked, status: 409 }

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
    const posted = await postCheckDepositLedger(supabase, {
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
  }

  const { data, error } = await supabase
    .from("checks")
    .update({
      status: "cleared",
      cleared_at: input.clearedAt,
      settlement_accounting_entry_id: settlementEntryId,
    })
    .eq("id", loaded.check.checkId)
    .eq("pop_id", popId)
    .eq("status", "deposited")
    .select("id")
    .maybeSingle()
  if (error) {
    if (!loaded.check.settlementAccountingEntryId && settlementEntryId) {
      await cancelCheckAccountingEntry(supabase, settlementEntryId)
    }
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    if (!loaded.check.settlementAccountingEntryId && settlementEntryId) {
      await cancelCheckAccountingEntry(supabase, settlementEntryId)
    }
    return { success: false, error: "El cheque ya no está depositado.", status: 409 }
  }
  return { success: true }
}

export async function rejectCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  checkId: string,
  input: RejectCheckBody,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "reject")
  if (blocked) return { success: false, error: blocked, status: 409 }

  const settledToBank = Boolean(loaded.check.settlementAccountingEntryId)
  const posted = await postCheckRejectLedger(supabase, {
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

  const { data, error } = await supabase
    .from("checks")
    .update({
      status: "rejected",
      rejected_at: input.rejectedAt,
      rejection_reason: input.reason.trim() || null,
    })
    .eq("id", loaded.check.checkId)
    .eq("pop_id", popId)
    .in("status", ["in_portfolio", "deposited"])
    .select("id")
    .maybeSingle()
  if (error) {
    await cancelCheckAccountingEntry(supabase, posted.entryId)
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    await cancelCheckAccountingEntry(supabase, posted.entryId)
    return { success: false, error: "El cheque ya no se puede rechazar.", status: 409 }
  }
  const reversed = await reversePaymentsLinkedToCheck(
    supabase,
    popId,
    loaded.check.checkId,
  )
  if (!reversed.success) {
    return { success: false, error: reversed.error, status: 500 }
  }
  return { success: true }
}

export async function voidCheck(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  siteId: string,
  checkId: string,
): Promise<MutateResult> {
  const loaded = await loadCheckForUpdate(supabase, popId, checkId)
  if (!loaded.ok) return { success: false, error: loaded.error, status: loaded.status }
  const blocked = lifecycleBlockedError(loaded.check.status, "void")
  if (blocked) return { success: false, error: blocked, status: 409 }

  const timeZone = await loadPopTimeZone(supabase, popId, siteId)
  const posted = await postCheckVoidLedger(supabase, {
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

  const { data, error } = await supabase
    .from("checks")
    .update({ status: "voided" })
    .eq("id", loaded.check.checkId)
    .eq("pop_id", popId)
    .eq("status", "in_portfolio")
    .select("id")
    .maybeSingle()
  if (error) {
    await cancelCheckAccountingEntry(supabase, posted.entryId)
    return { success: false, error: error.message, status: 500 }
  }
  if (!data) {
    await cancelCheckAccountingEntry(supabase, posted.entryId)
    return {
      success: false,
      error: "Solo se puede anular un cheque en cartera.",
      status: 409,
    }
  }
  const reversed = await reversePaymentsLinkedToCheck(
    supabase,
    popId,
    loaded.check.checkId,
  )
  if (!reversed.success) {
    return { success: false, error: reversed.error, status: 500 }
  }
  return { success: true }
}
