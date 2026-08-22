import type { SupabaseClient } from "@supabase/supabase-js"
import {
  entryDateIsoInTimezone,
  timezoneForPopLedger,
} from "../operations/timezone.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { canCloseCashRegisterSession } from "./access.js"
import {
  buildCashCloseAdjustmentLines,
  buildPaymentKindCloseAdjustmentLines,
  buildTreasuryLineCloseAdjustmentLines,
} from "./closeAccounting.js"
import {
  loadSessionCobrosForClose,
  loadSessionNonCashCobrosByKind,
} from "./cobros.js"
import type { CloseSessionBody } from "./schema.js"
import { computeEfectivoTeoricoSession } from "./sessionCash.js"

type CloseResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 403 | 404 | 409 | 500 }

async function cancelAccountingEntry(
  supabase: SupabaseClient,
  entryId: string,
) {
  await supabase
    .from("accounting_entries")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", entryId)
}

export async function closeCashSession(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  sessionId: string,
  userId: string,
  keys: readonly string[],
  isOwner: boolean,
  snapshot: CloseSessionBody,
): Promise<CloseResult> {
  const cash = parseMoney(snapshot.cash)
  const pm: Record<string, number> = {}
  for (const [k, v] of Object.entries(snapshot.payment_methods ?? {})) {
    const n = parseMoney(v)
    if (n < 0) {
      return { success: false, error: "Los montos no pueden ser negativos.", status: 400 }
    }
    pm[k] = n
  }
  const treasuryLines: Record<string, number> = {}
  for (const [k, v] of Object.entries(snapshot.treasury_lines ?? {})) {
    const n = parseMoney(v)
    if (n < 0) {
      return { success: false, error: "Los montos no pueden ser negativos.", status: 400 }
    }
    treasuryLines[k] = n
  }
  const useTreasuryLines = Object.keys(treasuryLines).length > 0
  const closeNote = snapshot.note?.trim() ?? ""
  const closing_snapshot: Record<string, unknown> = {
    cash,
    ...(useTreasuryLines
      ? { treasury_lines: treasuryLines }
      : { payment_methods: pm }),
  }
  if (closeNote.length > 0) closing_snapshot.note = closeNote

  const { data: openSessionRow, error: sessionLookupErr } = await supabase
    .from("cash_register_sessions")
    .select("id, opened_by, status")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (sessionLookupErr) {
    return {
      success: false,
      error: sessionLookupErr.message || "No se pudo validar el turno.",
      status: 500,
    }
  }
  if (!openSessionRow?.id || String(openSessionRow.status) !== "open") {
    return {
      success: false,
      error: "El turno no existe o ya está cerrado.",
      status: 409,
    }
  }
  const openedByUserId =
    openSessionRow.opened_by != null ? String(openSessionRow.opened_by) : null
  if (
    !canCloseCashRegisterSession({
      currentUserId: userId,
      openedByUserId,
      keys,
      isOwner,
    })
  ) {
    return {
      success: false,
      error:
        "Solo quien abrió el turno o un supervisor con permisos completos de cajas puede cerrarlo.",
      status: 403,
    }
  }

  const teorRes = await computeEfectivoTeoricoSession(supabase, popId, sessionId)
  if (!teorRes.success) {
    return { success: false, error: teorRes.error, status: 400 }
  }
  const cashDiff = roundMoney(cash - teorRes.teorico)
  let arqueoEntryId: string | null = null

  const cobrosByKind = await loadSessionNonCashCobrosByKind(
    supabase,
    popId,
    sessionId,
  )
  const cobrosByLine = await loadSessionCobrosForClose(supabase, popId, sessionId)

  let entryLines: {
    account_id: string
    debit_amount: number
    credit_amount: number
    description: string | null
    line_order: number
  }[] = []
  let nextLineOrder = 1

  const cashLinesRes = await buildCashCloseAdjustmentLines(
    supabase,
    popId,
    cashDiff,
    nextLineOrder,
  )
  if (!cashLinesRes.success) {
    return { success: false, error: cashLinesRes.error, status: 400 }
  }
  entryLines = entryLines.concat(cashLinesRes.lines)
  nextLineOrder = cashLinesRes.nextLineOrder

  if (useTreasuryLines) {
    const tlLinesRes = await buildTreasuryLineCloseAdjustmentLines(
      supabase,
      popId,
      treasuryLines,
      cobrosByLine,
      nextLineOrder,
    )
    if (!tlLinesRes.success) {
      return { success: false, error: tlLinesRes.error, status: 400 }
    }
    entryLines = entryLines.concat(tlLinesRes.lines)
  } else {
    const pmLinesRes = await buildPaymentKindCloseAdjustmentLines(
      supabase,
      popId,
      pm,
      cobrosByKind,
      nextLineOrder,
    )
    if (!pmLinesRes.success) {
      return { success: false, error: pmLinesRes.error, status: 400 }
    }
    entryLines = entryLines.concat(pmLinesRes.lines)
  }

  if (entryLines.length > 0) {
    const { data: pop } = await supabase
      .from("pops")
      .select("country")
      .eq("id", popId)
      .maybeSingle()
    const tz = timezoneForPopLedger(pop?.country, popSiteId)
    const entryDate = entryDateIsoInTimezone(tz)

    const { data: maxRow } = await supabase
      .from("accounting_entries")
      .select("entry_number")
      .eq("pop_id", popId)
      .order("entry_number", { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextNum =
      maxRow?.entry_number != null && Number.isFinite(Number(maxRow.entry_number))
        ? Number(maxRow.entry_number) + 1
        : 1

    const { data: entIns, error: entErr } = await supabase
      .from("accounting_entries")
      .insert({
        pop_id: popId,
        entry_number: nextNum,
        entry_date: entryDate,
        source_type: "cash_register_close",
        source_id: sessionId,
        description: "Ajustes de cierre de caja (arqueo y liquidación)",
        status: "draft",
        created_by: userId,
      })
      .select("id")
      .single()
    if (entErr || !entIns?.id) {
      return {
        success: false,
        error: entErr?.message || "No se pudo crear el asiento de arqueo.",
        status: 500,
      }
    }
    arqueoEntryId = String(entIns.id)

    const { error: linesErr } = await supabase
      .from("accounting_entry_lines")
      .insert(entryLines.map((line) => ({ ...line, entry_id: arqueoEntryId })))
    if (linesErr) {
      await cancelAccountingEntry(supabase, arqueoEntryId)
      return {
        success: false,
        error: linesErr.message || "No se pudo registrar el asiento de arqueo.",
        status: 500,
      }
    }

    const { error: postErr } = await supabase
      .from("accounting_entries")
      .update({
        status: "posted",
        posted_at: new Date().toISOString(),
        posted_by: userId,
      })
      .eq("id", arqueoEntryId)
    if (postErr) {
      await cancelAccountingEntry(supabase, arqueoEntryId)
      return {
        success: false,
        error: postErr.message || "No se pudo registrar el asiento de arqueo.",
        status: 500,
      }
    }
  }

  const { data: closedRow, error } = await supabase
    .from("cash_register_sessions")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: userId,
      closing_snapshot,
    })
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .select("id")
    .maybeSingle()
  if (error) {
    if (arqueoEntryId) await cancelAccountingEntry(supabase, arqueoEntryId)
    return {
      success: false,
      error: error.message || "No se pudo cerrar el turno.",
      status: 500,
    }
  }
  if (!closedRow) {
    if (arqueoEntryId) await cancelAccountingEntry(supabase, arqueoEntryId)
    return {
      success: false,
      error: "El turno no existe o ya está cerrado.",
      status: 409,
    }
  }
  return { success: true }
}
