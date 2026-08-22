import type { SupabaseClient } from "@supabase/supabase-js"
import { loadExpensePaymentContext } from "../expenses/paymentContext.js"
import { roundMoney } from "../reports/money.js"
import { resolveTreasuryAccountLedgerAccountId } from "../treasury/chart.js"
import { postBalancedEntry } from "../treasury/ledger.js"
import type { RecordEmployeePaymentBody } from "./schema.js"

const SALARY_EXPENSE_CODES = ["6.1.1.03"] as const

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 500 }

async function resolveAccountId(
  supabase: SupabaseClient,
  popId: string,
  codes: readonly string[],
): Promise<string | null> {
  for (const code of codes) {
    const { data: row } = await supabase
      .from("accounting_chart_of_accounts")
      .select("id")
      .eq("pop_id", popId)
      .eq("code", code)
      .maybeSingle()
    if (row?.id) return String(row.id)
  }
  return null
}

export async function loadHrPaymentContext(
  supabase: SupabaseClient,
  popId: string,
) {
  return loadExpensePaymentContext(supabase, popId)
}

export async function recordEmployeePayment(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  employeeId: string,
  input: RecordEmployeePaymentBody,
): Promise<MutateResult> {
  const amount = roundMoney(input.amount)
  if (!(amount > 0)) {
    return { success: false, error: "El importe debe ser mayor a cero.", status: 400 }
  }

  const { data: employee } = await supabase
    .from("pop_employees")
    .select("id, first_name, last_name")
    .eq("pop_id", popId)
    .eq("id", employeeId)
    .maybeSingle()
  if (!employee) {
    return { success: false, error: "No encontramos a esa persona.", status: 404 }
  }

  const { data: treasury } = await supabase
    .from("treasury_accounts")
    .select("id, name, is_active")
    .eq("pop_id", popId)
    .eq("id", input.treasuryAccountId)
    .maybeSingle()
  if (!treasury || treasury.is_active === false) {
    return { success: false, error: "Elegí de qué cuenta sale el pago.", status: 400 }
  }

  const paymentAccountId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    input.treasuryAccountId,
  )
  if (!paymentAccountId) {
    return {
      success: false,
      error: "Esa cuenta de tesorería no tiene cuenta en el plan.",
      status: 400,
    }
  }

  const salaryAccountId = await resolveAccountId(
    supabase,
    popId,
    SALARY_EXPENSE_CODES,
  )
  if (!salaryAccountId) {
    return {
      success: false,
      error: "Falta la cuenta de sueldos en el plan de cuentas (6.1.1.03).",
      status: 400,
    }
  }

  const name = `${String(employee.first_name ?? "").trim()} ${String(employee.last_name ?? "").trim()}`.trim()
    || "Persona"
  const notes = input.notes?.trim() || ""
  const description = notes
    ? `Sueldo — ${name} — ${notes}`
    : `Sueldo — ${name}`

  const { data: payIns, error: payErr } = await supabase
    .from("pop_employee_payments")
    .insert({
      pop_id: popId,
      employee_id: employeeId,
      amount,
      paid_at: input.paidAt,
      payment_kind: input.paymentKind,
      treasury_account_id: input.treasuryAccountId,
      notes: notes || null,
      created_by: userId,
    })
    .select("id")
    .single()

  if (payErr || !payIns?.id) {
    return {
      success: false,
      error: payErr?.message || "No se pudo registrar el pago.",
      status: 500,
    }
  }

  const paymentId = String(payIns.id)
  const ledger = await postBalancedEntry(supabase, {
    popId,
    userId,
    entryDate: input.paidAt,
    sourceType: "employee_payment",
    sourceId: paymentId,
    description,
    lines: [
      {
        account_id: salaryAccountId,
        debit_amount: amount,
        credit_amount: 0,
        description,
        line_order: 1,
      },
      {
        account_id: paymentAccountId,
        debit_amount: 0,
        credit_amount: amount,
        description,
        line_order: 2,
      },
    ],
  })

  if (!ledger.success) {
    await supabase
      .from("pop_employee_payments")
      .delete()
      .eq("id", paymentId)
      .eq("pop_id", popId)
    return { success: false, error: ledger.error, status: 400 }
  }

  const { error: linkErr } = await supabase
    .from("pop_employee_payments")
    .update({ accounting_entry_id: ledger.entryId })
    .eq("id", paymentId)
    .eq("pop_id", popId)
  if (linkErr) {
    return {
      success: false,
      error:
        "El pago salió de tesorería, pero no se pudo vincular el asiento. Contactá soporte.",
      status: 500,
    }
  }

  return { success: true }
}
