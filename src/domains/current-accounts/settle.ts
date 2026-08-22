import type { SupabaseClient } from "@supabase/supabase-js"
import {
  currentAccountDocumentKindForDirection,
  currentAccountOpenAmount,
  roundMoney,
} from "./accounts.js"
import { loadOpenDocuments, loadPopTimeZone } from "./documents.js"
import {
  cancelCurrentAccountAccountingEntry,
  postCurrentAccountReceiptLedger,
} from "./ledger.js"
import type { CurrentAccountDirection, SettleBody } from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

async function resolveOpenCashSession(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
): Promise<
  | { success: true; sessionId: string; cashTreasuryAccountId: string }
  | { success: false; error: string }
> {
  const { data: regs, error: regErr } = await supabase
    .from("cash_registers")
    .select("id, name, sort_order, cash_treasury_account_id")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (regErr) {
    return { success: false, error: regErr.message || "No se pudieron leer las cajas." }
  }
  const { data: sessions, error: sessErr } = await supabase
    .from("cash_register_sessions")
    .select("id, cash_register_id, opened_by")
    .eq("pop_id", popId)
    .eq("status", "open")
  if (sessErr) {
    return {
      success: false,
      error: sessErr.message || "No se pudieron leer sesiones de caja.",
    }
  }
  const openByReg = new Map<string, { id: string; opened_by: string }>()
  for (const s of sessions || []) {
    openByReg.set(String(s.cash_register_id), {
      id: String(s.id),
      opened_by: String(s.opened_by),
    })
  }
  const openEntries = (regs || []).flatMap((r) => {
    const session = openByReg.get(String(r.id))
    return session ? [{ register: r, session }] : []
  })
  if (openEntries.length === 0) {
    return {
      success: false,
      error: "No hay sesión de caja abierta. Abrí una caja desde el menú Cajas antes de vender.",
    }
  }
  const pick =
    openEntries.find((e) => e.session.opened_by === userId) ?? openEntries[0]
  const cashTreasuryAccountId = pick.register.cash_treasury_account_id
    ? String(pick.register.cash_treasury_account_id)
    : null
  if (!cashTreasuryAccountId) {
    return {
      success: false,
      error: "La caja abierta no tiene cuenta de efectivo configurada.",
    }
  }
  return {
    success: true,
    sessionId: pick.session.id,
    cashTreasuryAccountId,
  }
}

async function assertCashSessionStillOpen(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const { data, error } = await supabase
    .from("cash_register_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()
  if (error) {
    return { success: false, error: error.message || "No se pudo validar la sesión de caja." }
  }
  if (!data?.id) {
    return {
      success: false,
      error: "La sesión de caja se cerró. Abrí un turno en Cajas antes de continuar.",
    }
  }
  return { success: true }
}

function parseCheckoutCheckDetails(input: unknown):
  | {
      ok: true
      details: {
        checkNumber: string
        bankName: string
        issueDate: string
        dueDate: string
        partyName: string
        partyId: string
        notes: string
      }
    }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Completá los datos del cheque." }
  }
  const raw = input as Record<string, unknown>
  const checkNumber = String(raw.checkNumber ?? "").trim()
  if (!checkNumber) return { ok: false, error: "El número de cheque es obligatorio." }
  const bankName = String(raw.bankName ?? "").trim()
  if (!bankName) return { ok: false, error: "El banco es obligatorio." }
  const issueDate = String(raw.issueDate ?? "").trim()
  const dueDate = String(raw.dueDate ?? "").trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { ok: false, error: "Revisá las fechas de emisión y cobro." }
  }
  return {
    ok: true,
    details: {
      checkNumber,
      bankName,
      issueDate,
      dueDate,
      partyName: String(raw.partyName ?? "").trim(),
      partyId: String(raw.partyId ?? "").trim(),
      notes: String(raw.notes ?? "").trim(),
    },
  }
}

async function resolveCheckTreasuryAccountId(
  supabase: SupabaseClient,
  popId: string,
  direction: "received" | "issued",
): Promise<string | null> {
  const kind = direction === "issued" ? "check_payable" : "check_receivable"
  const { data } = await supabase
    .from("treasury_accounts")
    .select("id")
    .eq("pop_id", popId)
    .eq("kind", kind)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.id ? String(data.id) : null
}

export async function settleCurrentAccount(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  userId: string,
  input: SettleBody,
): Promise<MutateResult> {
  const requested = new Map<string, number>()
  for (const row of input.applications) {
    const amount = roundMoney(Number(row.amount ?? 0) || 0)
    if (amount <= 0.009) continue
    requested.set(row.documentId, roundMoney((requested.get(row.documentId) ?? 0) + amount))
  }

  const extraAmount = Math.max(0, roundMoney(Number(input.extraAmount ?? 0) || 0))
  const notes = String(input.notes ?? "").trim().slice(0, 500) || null
  const timeZone = await loadPopTimeZone(supabase, popId, siteId)
  const documents = await loadOpenDocuments(
    supabase,
    popId,
    input.direction,
    timeZone,
    input.partyId,
  )
  const remainingById = new Map(documents.map((doc) => [doc.id, doc.remaining]))

  const applications: { documentId: string; amount: number }[] = []
  for (const [documentId, asked] of requested) {
    const remaining = remainingById.get(documentId)
    if (remaining == null) {
      return {
        success: false,
        error: "Uno de los comprobantes ya no está abierto.",
        status: 409,
      }
    }
    const amount = Math.min(asked, remaining)
    if (amount <= 0.009) continue
    applications.push({ documentId, amount: roundMoney(amount) })
  }

  const appliedTotal = applications.reduce((sum, row) => roundMoney(sum + row.amount), 0)
  const receiptAmount = roundMoney(appliedTotal + extraAmount)
  if (!(receiptAmount > 0.009)) {
    return {
      success: false,
      error: "El cobro o pago tiene que ser mayor a cero.",
      status: 400,
    }
  }

  const partyTable = input.direction === "receivable" ? "clients" : "suppliers"
  const { data: partyRow } = await supabase
    .from(partyTable)
    .select("id, name")
    .eq("id", input.partyId)
    .maybeSingle()
  if (!partyRow) {
    return {
      success: false,
      error:
        input.direction === "receivable"
          ? "No se encontró el cliente."
          : "No se encontró el proveedor.",
      status: 404,
    }
  }
  const partyName = String(partyRow.name ?? "").trim() || "—"
  const kind = currentAccountDocumentKindForDirection(input.direction)
  const checkFlow = input.direction === "payable" ? "purchase" : "sale"
  let treasuryAccountId = String(input.treasuryAccountId ?? "").trim()
  let checkId: string | null = null
  let cashRegisterSessionId: string | null = null

  if (input.paymentKind === "cash") {
    const cashRes = await resolveOpenCashSession(supabase, popId, userId)
    if (!cashRes.success) return { success: false, error: cashRes.error, status: 400 }
    const stillOpen = await assertCashSessionStillOpen(supabase, popId, cashRes.sessionId)
    if (!stillOpen.success) return { success: false, error: stillOpen.error, status: 409 }
    cashRegisterSessionId = cashRes.sessionId
    treasuryAccountId = cashRes.cashTreasuryAccountId
  }

  if (input.paymentKind === "check") {
    const parsed = parseCheckoutCheckDetails(input.checkDetails)
    if (!parsed.ok) return { success: false, error: parsed.error, status: 400 }
    const details = {
      ...parsed.details,
      partyId: parsed.details.partyId || input.partyId,
      partyName: parsed.details.partyName || partyName,
    }
    const checkDirection = checkFlow === "purchase" ? "issued" : "received"
    const resolved = await resolveCheckTreasuryAccountId(supabase, popId, checkDirection)
    if (!resolved) {
      return {
        success: false,
        error: "Configurá una cuenta de cheques en tesorería.",
        status: 400,
      }
    }
    treasuryAccountId = resolved
    const firstApp = applications[0]
    const sourceKind = firstApp ? kind : "manual"
    if (sourceKind !== "manual" && !firstApp?.documentId) {
      return { success: false, error: "Falta el comprobante de origen del cheque.", status: 400 }
    }
    const { data, error } = await supabase
      .from("checks")
      .insert({
        pop_id: popId,
        direction: checkDirection,
        check_number: details.checkNumber,
        bank_name: details.bankName,
        amount: receiptAmount,
        issue_date: details.issueDate,
        due_date: details.dueDate,
        status: "in_portfolio",
        source_kind: sourceKind,
        source_id: firstApp?.documentId || null,
        client_id: checkDirection === "received" ? details.partyId || null : null,
        supplier_id: checkDirection === "issued" ? details.partyId || null : null,
        drawer_name: checkDirection === "received" ? details.partyName || null : null,
        payee_name: checkDirection === "issued" ? details.partyName || null : null,
        notes: details.notes || null,
        created_by: userId,
      })
      .select("id")
      .single()
    if (error || !data?.id) {
      return {
        success: false,
        error: error?.message || "No se pudo registrar el cheque.",
        status: 500,
      }
    }
    checkId = String(data.id)
  } else if (!/^[0-9a-f-]{36}$/i.test(treasuryAccountId)) {
    return { success: false, error: "Elegí un medio de cobro o pago.", status: 400 }
  }

  const { data: receiptRow, error: receiptErr } = await supabase
    .from("current_account_receipts")
    .insert({
      pop_id: popId,
      direction: input.direction,
      client_id: input.direction === "receivable" ? input.partyId : null,
      supplier_id: input.direction === "payable" ? input.partyId : null,
      amount: receiptAmount,
      paid_at: input.paidAt,
      payment_kind: input.paymentKind,
      treasury_account_id: treasuryAccountId,
      check_id: checkId,
      cash_register_session_id: cashRegisterSessionId,
      notes,
      created_by: userId,
    })
    .select("id")
    .single()
  if (receiptErr || !receiptRow?.id) {
    if (checkId) await supabase.from("checks").delete().eq("id", checkId)
    return {
      success: false,
      error: receiptErr?.message || "No se pudo registrar el recibo.",
      status: 500,
    }
  }
  const receiptId = String(receiptRow.id)

  if (applications.length > 0) {
    const { error: appErr } = await supabase.from("current_account_applications").insert(
      applications.map((row) => ({
        pop_id: popId,
        receipt_id: receiptId,
        document_kind: kind,
        document_id: row.documentId,
        amount: row.amount,
      })),
    )
    if (appErr) {
      await supabase.from("current_account_receipts").delete().eq("id", receiptId)
      if (checkId) await supabase.from("checks").delete().eq("id", checkId)
      return {
        success: false,
        error: appErr.message || "No se pudieron imputar los comprobantes.",
        status: 500,
      }
    }
  }

  const posted = await postCurrentAccountReceiptLedger(supabase, {
    popId,
    userId,
    receiptId,
    direction: input.direction,
    amount: receiptAmount,
    entryDate: input.paidAt,
    partyName,
    paymentKind: input.paymentKind,
    treasuryAccountId,
  })
  if (!posted.success) {
    await supabase.from("current_account_receipts").delete().eq("id", receiptId)
    if (checkId) await supabase.from("checks").delete().eq("id", checkId)
    return { success: false, error: posted.error, status: 400 }
  }

  const { error: linkErr } = await supabase
    .from("current_account_receipts")
    .update({ accounting_entry_id: posted.entryId })
    .eq("id", receiptId)
    .eq("pop_id", popId)
  if (linkErr) {
    await cancelCurrentAccountAccountingEntry(supabase, posted.entryId)
    await supabase.from("current_account_receipts").delete().eq("id", receiptId)
    if (checkId) await supabase.from("checks").delete().eq("id", checkId)
    return {
      success: false,
      error: linkErr.message || "No se pudo vincular el asiento al recibo.",
      status: 500,
    }
  }

  if (checkId) {
    await supabase
      .from("checks")
      .update({ received_accounting_entry_id: posted.entryId })
      .eq("id", checkId)
      .eq("pop_id", popId)
  }

  return { success: true }
}

export async function loadUnappliedReceipts(
  supabase: SupabaseClient,
  popId: string,
  direction: CurrentAccountDirection,
  partyId: string,
): Promise<{ id: string; leftover: number }[]> {
  const query =
    direction === "receivable"
      ? supabase
          .from("current_account_receipts")
          .select("id, amount, paid_at")
          .eq("pop_id", popId)
          .eq("direction", "receivable")
          .eq("client_id", partyId)
          .order("paid_at", { ascending: true })
      : supabase
          .from("current_account_receipts")
          .select("id, amount, paid_at")
          .eq("pop_id", popId)
          .eq("direction", "payable")
          .eq("supplier_id", partyId)
          .order("paid_at", { ascending: true })
  const { data: receipts } = await query
  if (!receipts?.length) return []

  const receiptIds = receipts.map((row) => String(row.id))
  const { data: appRows } = await supabase
    .from("current_account_applications")
    .select("receipt_id, amount")
    .eq("pop_id", popId)
    .in("receipt_id", receiptIds)
  const applied = new Map<string, number>()
  for (const row of appRows ?? []) {
    const id = String(row.receipt_id ?? "")
    applied.set(id, roundMoney((applied.get(id) ?? 0) + Number(row.amount ?? 0)))
  }

  return receipts.flatMap((row) => {
    const leftover = currentAccountOpenAmount(
      Number(row.amount ?? 0) || 0,
      applied.get(String(row.id)) ?? 0,
    )
    if (leftover <= 0.009) return []
    return [{ id: String(row.id), leftover }]
  })
}
