import type { SupabaseClient } from "@supabase/supabase-js"
import {
  isValidOperationPaymentKind,
  parseCheckoutCheckDetails,
  roundMoney,
} from "./accounts.js"
import { postExpensePaymentLedger, postExpenseVoidReversals } from "./ledger.js"
import { expenseDateBelongsToMonth } from "./month.js"
import type { CreateExpenseBody, RecordExpensePaymentBody } from "./schema.js"
import { entryDateIsoInTimezone, timezoneForPopLedger } from "./timezone.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

type CreateResult =
  | { success: true; data: { id: string } }
  | { success: false; error: string; status: 400 | 404 | 500 }

async function resolveCheckTreasuryAccountId(
  supabase: SupabaseClient,
  popId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("treasury_accounts")
    .select("id")
    .eq("pop_id", popId)
    .eq("kind", "check_payable")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.id ? String(data.id) : null
}

export async function createExpense(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: CreateExpenseBody,
): Promise<CreateResult> {
  const amount = roundMoney(input.amount)
  if (!(amount > 0)) {
    return { success: false, error: "El importe debe ser mayor a cero.", status: 400 }
  }
  if (!expenseDateBelongsToMonth(input.expenseDate, input.year, input.month)) {
    return {
      success: false,
      error: "La fecha del gasto debe estar dentro del mes seleccionado.",
      status: 400,
    }
  }

  const { data: catOk, error: catErr } = await supabase
    .from("expense_categories")
    .select("id, kind")
    .eq("id", input.categoryId.trim())
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
  if (catErr || !catOk) {
    return { success: false, error: "Categoría inválida o eliminada.", status: 400 }
  }
  if (String(catOk.kind) === "otro") {
    return {
      success: false,
      error: "Esa cuenta la registra otro módulo. Acá solo se mira.",
      status: 400,
    }
  }

  const { data: ins, error } = await supabase
    .from("expenses")
    .insert({
      pop_id: popId,
      category_id: input.categoryId.trim(),
      amount,
      currency: "ARS",
      expense_date: input.expenseDate.trim(),
      due_date: input.dueDate?.trim() || null,
      description: (input.description ?? "").trim(),
      created_by: userId,
    })
    .select("id")
    .maybeSingle()
  if (error || !ins) {
    return {
      success: false,
      error: error?.message || "No se pudo crear el gasto.",
      status: 500,
    }
  }
  return { success: true, data: { id: String(ins.id) } }
}

export async function recordExpensePayment(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  expenseId: string,
  input: RecordExpensePaymentBody,
): Promise<MutateResult> {
  const amt = roundMoney(input.amount)
  if (!(amt > 0)) {
    return {
      success: false,
      error: "El importe del pago debe ser mayor a cero.",
      status: 400,
    }
  }

  const kind = input.paymentKind?.trim() || null
  let taId = input.treasuryAccountId?.trim() || null
  let parsedCheck: {
    checkNumber: string
    bankName: string
    issueDate: string
    dueDate: string
    partyName: string
    partyId: string
    notes: string
  } | null = null

  if (kind && !isValidOperationPaymentKind(kind)) {
    return { success: false, error: "Tipo de pago inválido.", status: 400 }
  }

  if (kind === "check") {
    const parsed = parseCheckoutCheckDetails(input.checkDetails)
    if (!parsed.ok) return { success: false, error: parsed.error, status: 400 }
    parsedCheck = parsed.details
    const checkTreasuryId = await resolveCheckTreasuryAccountId(supabase, popId)
    if (!checkTreasuryId) {
      return {
        success: false,
        error: "Faltan las cuentas de cheques. Recargá la página o contactá a soporte.",
        status: 400,
      }
    }
    taId = checkTreasuryId
  }

  if (kind && taId) {
    const { data: taRow, error: taErr } = await supabase
      .from("treasury_accounts")
      .select("id")
      .eq("id", taId)
      .eq("pop_id", popId)
      .eq("is_active", true)
      .maybeSingle()
    if (taErr || !taRow) {
      return { success: false, error: "Cuenta de tesorería inválida.", status: 400 }
    }
  }

  let checkId: string | null = null
  if (kind === "check" && parsedCheck) {
    const { data, error } = await supabase
      .from("checks")
      .insert({
        pop_id: popId,
        direction: "issued",
        check_number: parsedCheck.checkNumber,
        bank_name: parsedCheck.bankName,
        amount: amt,
        issue_date: parsedCheck.issueDate,
        due_date: parsedCheck.dueDate,
        status: "in_portfolio",
        source_kind: "expense",
        source_id: expenseId.trim(),
        client_id: null,
        supplier_id: parsedCheck.partyId || null,
        drawer_name: null,
        payee_name: parsedCheck.partyName || null,
        notes: parsedCheck.notes || null,
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
  }

  const { data: payIns, error } = await supabase
    .from("expense_payments")
    .insert({
      pop_id: popId,
      expense_id: expenseId.trim(),
      amount: amt,
      paid_at: input.paidAt.trim(),
      payment_kind: kind,
      treasury_account_id: taId,
      created_by: userId,
      check_id: checkId,
    })
    .select("id")
    .maybeSingle()
  if (error || !payIns?.id) {
    if (checkId) await supabase.from("checks").delete().eq("id", checkId)
    return {
      success: false,
      error: error?.message || "No se pudo registrar el pago.",
      status: 500,
    }
  }

  const paymentId = String(payIns.id)
  const ledger = await postExpensePaymentLedger(supabase, {
    popId,
    userId,
    expensePaymentId: paymentId,
  })
  if (!ledger.success) {
    await supabase.from("expense_payments").delete().eq("id", paymentId).eq("pop_id", popId)
    if (checkId) await supabase.from("checks").delete().eq("id", checkId)
    return { success: false, error: ledger.error, status: 400 }
  }
  return { success: true }
}

export async function deleteExpense(
  supabase: SupabaseClient,
  popId: string,
  expenseId: string,
): Promise<MutateResult> {
  const { count, error: cErr } = await supabase
    .from("expense_payments")
    .select("id", { count: "exact", head: true })
    .eq("expense_id", expenseId.trim())
    .eq("pop_id", popId)
  if (cErr) {
    return {
      success: false,
      error: cErr.message || "No se pudo verificar pagos.",
      status: 500,
    }
  }
  if ((count ?? 0) > 0) {
    return {
      success: false,
      error: "No se puede eliminar un gasto que ya tiene pagos. Anulalo en su lugar.",
      status: 409,
    }
  }
  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("id", expenseId.trim())
    .eq("pop_id", popId)
  if (error) {
    return { success: false, error: error.message || "No se pudo eliminar.", status: 500 }
  }
  return { success: true }
}

export async function voidExpense(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  userId: string,
  expenseId: string,
  reason: string,
): Promise<MutateResult> {
  const { data: pop } = await supabase
    .from("pops")
    .select("country")
    .eq("id", popId)
    .maybeSingle()
  const tz = timezoneForPopLedger(pop?.country, siteId)
  const entryDate = entryDateIsoInTimezone(tz)
  const eid = expenseId.trim()

  const rev = await postExpenseVoidReversals(supabase, {
    popId,
    userId,
    expenseId: eid,
    entryDate,
  })
  if (!rev.success) return { success: false, error: rev.error, status: 400 }

  const { data: upd, error } = await supabase
    .from("expenses")
    .update({
      status: "voided",
      voided_at: new Date().toISOString(),
      void_reason: reason.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eid)
    .eq("pop_id", popId)
    .neq("status", "voided")
    .select("id")
    .maybeSingle()
  if (error) {
    return { success: false, error: error.message || "No se pudo anular.", status: 500 }
  }
  if (!upd) {
    const { data: st } = await supabase
      .from("expenses")
      .select("status")
      .eq("id", eid)
      .eq("pop_id", popId)
      .maybeSingle()
    if (String(st?.status ?? "") === "voided") {
      return { success: true }
    }
    return {
      success: false,
      error: "El gasto no existe o ya estaba anulado.",
      status: 404,
    }
  }
  return { success: true }
}
