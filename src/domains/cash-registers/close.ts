import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
} from "../../audit/ledgerOps.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
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

export async function closeCashSession(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  sessionId: string,
  userId: string,
  keys: readonly string[],
  isOwner: boolean,
  snapshot: CloseSessionBody,
  audit: MutationAuditCtx,
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

  const ops: AuditOp[] = []

  if (entryLines.length > 0) {
    const { data: pop } = await supabase
      .from("pops")
      .select("country")
      .eq("id", popId)
      .maybeSingle()
    const tz = timezoneForPopLedger(pop?.country, popSiteId)
    const entryDate = entryDateIsoInTimezone(tz)
    const nextNum = await nextAccountingEntryNumber(supabase, popId)
    const description = "Ajustes de cierre de caja (arqueo y liquidación)"
    const ledger = postedAccountingEntryOps({
      popId,
      userId,
      entryNumber: nextNum,
      entryDate,
      sourceType: "cash_register_close",
      sourceId: sessionId,
      description,
      lines: entryLines.map((line) => ({
        account_id: line.account_id,
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
        description: line.description ?? description,
        line_order: line.line_order,
      })),
    })
    ops.push(...ledger.ops)
  }

  ops.push({
    op: "update",
    table: "cash_register_sessions",
    id: sessionId,
    row: {
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: userId,
      closing_snapshot,
    },
  })

  const applied = await applyWithAudit(supabase, {
    kind: "cash_registers.session.close",
    ctx: audit,
    popId,
    resourceId: sessionId,
    previous: { status: "open" },
    next: { status: "closed", closing_snapshot },
    ops: ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
