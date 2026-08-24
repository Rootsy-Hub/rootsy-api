import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import { auditedDelete, auditedInsert } from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import {
  isValidOperationPaymentKind,
  parseCheckoutCheckDetails,
  roundMoney,
} from "./accounts.js"
import {
  buildExpensePaymentLedgerOps,
  buildExpenseVoidReversalOps,
} from "./ledger.js"
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
  audit: MutationAuditCtx,
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

  const id = randomUUID()
  const row = {
    id,
    pop_id: popId,
    category_id: input.categoryId.trim(),
    amount,
    currency: "ARS",
    expense_date: input.expenseDate.trim(),
    due_date: input.dueDate?.trim() || null,
    description: (input.description ?? "").trim(),
    created_by: userId,
  }
  const applied = await auditedInsert(supabase, {
    kind: "expenses.create",
    table: "expenses",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, data: { id } }
}

export async function recordExpensePayment(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  expenseId: string,
  input: RecordExpensePaymentBody,
  audit: MutationAuditCtx,
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

  const paymentId = randomUUID()
  const ops: AuditOp[] = []
  let checkId: string | null = null
  if (kind === "check" && parsedCheck) {
    checkId = randomUUID()
    ops.push({
      op: "insert",
      table: "checks",
      row: {
        id: checkId,
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
      },
    })
  }

  const ledger = await buildExpensePaymentLedgerOps(supabase, {
    popId,
    userId,
    expensePaymentId: paymentId,
    expenseId: expenseId.trim(),
    amount: amt,
    paidAt: input.paidAt.trim(),
    paymentKind: kind,
    treasuryAccountId: taId,
  })
  if (!ledger.success) {
    return { success: false, error: ledger.error, status: 400 }
  }

  ops.push({
    op: "insert",
    table: "expense_payments",
    row: {
      id: paymentId,
      pop_id: popId,
      expense_id: expenseId.trim(),
      amount: amt,
      paid_at: input.paidAt.trim(),
      payment_kind: kind,
      treasury_account_id: taId,
      created_by: userId,
      check_id: checkId,
      accounting_entry_id: ledger.entryId,
    },
  })
  ops.push(...ledger.ops)

  const applied = await applyWithAudit(supabase, {
    kind: "expenses.payment",
    ctx: audit,
    popId,
    resourceId: paymentId,
    previous: null,
    next: { paymentId, expenseId, amount: amt },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function deleteExpense(
  supabase: SupabaseClient,
  popId: string,
  expenseId: string,
  audit: MutationAuditCtx,
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
  const { data: existing } = await supabase
    .from("expenses")
    .select("id, description, amount")
    .eq("id", expenseId.trim())
    .eq("pop_id", popId)
    .maybeSingle()
  if (!existing?.id) {
    return { success: false, error: "No se encontró el gasto.", status: 404 }
  }
  const applied = await auditedDelete(supabase, {
    kind: "expenses.delete",
    table: "expenses",
    id: expenseId.trim(),
    ctx: audit,
    popId,
    previous: existing,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
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
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: pop } = await supabase
    .from("pops")
    .select("country")
    .eq("id", popId)
    .maybeSingle()
  const tz = timezoneForPopLedger(pop?.country, siteId)
  const entryDate = entryDateIsoInTimezone(tz)
  const eid = expenseId.trim()

  const { data: current } = await supabase
    .from("expenses")
    .select("id, status")
    .eq("id", eid)
    .eq("pop_id", popId)
    .maybeSingle()
  if (!current?.id) {
    return { success: false, error: "El gasto no existe o ya estaba anulado.", status: 404 }
  }
  if (String(current.status ?? "") === "voided") {
    return { success: true }
  }

  const rev = await buildExpenseVoidReversalOps(supabase, {
    popId,
    userId,
    expenseId: eid,
    entryDate,
  })
  if (!rev.success) return { success: false, error: rev.error, status: 400 }

  const ops: AuditOp[] = [
    ...rev.ops,
    {
      op: "update",
      table: "expenses",
      id: eid,
      row: {
        status: "voided",
        voided_at: new Date().toISOString(),
        void_reason: reason.trim() || null,
        updated_at: new Date().toISOString(),
      },
    },
  ]

  const applied = await applyWithAudit(supabase, {
    kind: "expenses.void",
    ctx: audit,
    popId,
    resourceId: eid,
    previous: current,
    next: { status: "voided" },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
