import type { SupabaseClient } from "@supabase/supabase-js"
import { isValidOperationPaymentKind, roundMoney } from "./accounts.js"
import type { OperationPaymentKind } from "./schema.js"

const PAYMENT_KIND_ACCOUNT_FALLBACK: Record<
  OperationPaymentKind,
  readonly string[]
> = {
  cash: ["1.1.1.01"],
  transfer: ["1.1.1.02", "1.1.1.04"],
  card_debit: ["1.1.1.03"],
  card_credit: ["1.1.1.03"],
  check: ["1.1.2.02", "2.1.1.02"],
  other: ["1.1.1.02", "1.1.1.04"],
}

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

async function resolveTreasuryAccountLedgerAccountId(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("treasury_accounts")
    .select("accounting_chart_account_id")
    .eq("pop_id", popId)
    .eq("id", treasuryAccountId)
    .maybeSingle()
  return data?.accounting_chart_account_id
    ? String(data.accounting_chart_account_id)
    : null
}

async function resolveLedgerAccountForTreasuryPayment(
  supabase: SupabaseClient,
  popId: string,
  paymentKind: string,
  treasuryAccountId: string | null | undefined,
): Promise<string | null> {
  const kind = isValidOperationPaymentKind(paymentKind) ? paymentKind : "other"
  const taId = treasuryAccountId?.trim() || null
  if (taId) {
    const fromTreasury = await resolveTreasuryAccountLedgerAccountId(
      supabase,
      popId,
      taId,
    )
    if (fromTreasury) return fromTreasury
  }
  return resolveAccountId(supabase, popId, PAYMENT_KIND_ACCOUNT_FALLBACK[kind])
}

async function nextEntryNumber(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data: maxRow } = await supabase
    .from("accounting_entries")
    .select("entry_number")
    .eq("pop_id", popId)
    .order("entry_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  return maxRow?.entry_number != null && Number.isFinite(Number(maxRow.entry_number))
    ? Number(maxRow.entry_number) + 1
    : 1
}

async function cancelEntry(
  supabase: SupabaseClient,
  entryId: string,
): Promise<void> {
  await supabase
    .from("accounting_entries")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", entryId)
}

export async function postExpensePaymentLedger(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    expensePaymentId: string
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const { popId, userId, expensePaymentId } = args

  const { data: payRow, error: payErr } = await supabase
    .from("expense_payments")
    .select(
      "id, amount, paid_at, payment_kind, treasury_account_id, accounting_entry_id, expense_id",
    )
    .eq("id", expensePaymentId)
    .eq("pop_id", popId)
    .maybeSingle()

  if (payErr || !payRow) {
    return { success: false, error: payErr?.message || "Pago de gasto no encontrado." }
  }
  if (payRow.accounting_entry_id) {
    return { success: true }
  }

  const { data: expRow, error: expErr } = await supabase
    .from("expenses")
    .select(
      `
      id,
      description,
      status,
      expense_categories ( name, kind, accounting_chart_account_id )
    `,
    )
    .eq("id", String(payRow.expense_id))
    .eq("pop_id", popId)
    .maybeSingle()

  if (expErr || !expRow) {
    return { success: false, error: expErr?.message || "Gasto no encontrado." }
  }

  const catRaw = expRow.expense_categories as unknown as
    | {
        name?: string
        kind?: string
        accounting_chart_account_id?: string | null
      }
    | {
        name?: string
        kind?: string
        accounting_chart_account_id?: string | null
      }[]
    | null
  const cat = Array.isArray(catRaw) ? catRaw[0] : catRaw
  if (String(expRow.status ?? "") === "voided") {
    return { success: false, error: "El gasto está anulado." }
  }
  if (String(cat?.kind ?? "") === "otro") {
    return {
      success: false,
      error: "Esa cuenta la registra otro módulo. Acá solo se mira.",
    }
  }

  const amt = roundMoney(Number(payRow.amount ?? 0))
  if (!(amt > 0)) {
    return { success: false, error: "Importe de pago inválido." }
  }

  const categoryName = String(cat?.name ?? "")
  const expenseDesc = String(expRow.description ?? "").trim()
  const paidAt = String(payRow.paid_at ?? "").slice(0, 10)
  const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(paidAt)
    ? paidAt
    : new Date().toISOString().slice(0, 10)

  const paymentKind =
    payRow.payment_kind != null ? String(payRow.payment_kind) : "other"
  const treasuryAccountId =
    payRow.treasury_account_id != null
      ? String(payRow.treasury_account_id)
      : null
  const paymentAccountId = await resolveLedgerAccountForTreasuryPayment(
    supabase,
    popId,
    paymentKind,
    treasuryAccountId,
  )
  if (!paymentAccountId) {
    return {
      success: false,
      error:
        "Configurá una cuenta contable en el medio de pago o el plan de cuentas (caja/bancos) para registrar el pago.",
    }
  }

  const expenseAccountId =
    cat?.accounting_chart_account_id != null
      ? String(cat.accounting_chart_account_id)
      : null
  if (!expenseAccountId) {
    return {
      success: false,
      error: "Esta categoría no tiene cuenta en el plan de cuentas.",
    }
  }

  const entryDescription = `Gasto — ${categoryName || "Sin categoría"}${expenseDesc ? ` — ${expenseDesc}` : ""}`

  const nextNum = await nextEntryNumber(supabase, popId)
  const { data: entIns, error: entErr } = await supabase
    .from("accounting_entries")
    .insert({
      pop_id: popId,
      entry_number: nextNum,
      entry_date: entryDate,
      source_type: "expense_payment",
      source_id: expensePaymentId,
      description: entryDescription,
      status: "draft",
      created_by: userId,
    })
    .select("id")
    .single()

  if (entErr || !entIns?.id) {
    return { success: false, error: entErr?.message || "No se pudo crear el asiento contable." }
  }
  const entryId = String(entIns.id)

  const { error: linesErr } = await supabase.from("accounting_entry_lines").insert([
    {
      entry_id: entryId,
      account_id: expenseAccountId,
      debit_amount: amt,
      credit_amount: 0,
      description: entryDescription,
      line_order: 1,
    },
    {
      entry_id: entryId,
      account_id: paymentAccountId,
      debit_amount: 0,
      credit_amount: amt,
      description: entryDescription,
      line_order: 2,
    },
  ])
  if (linesErr) {
    await cancelEntry(supabase, entryId)
    return {
      success: false,
      error: linesErr.message || "No se pudieron crear las líneas del asiento.",
    }
  }

  const { error: postErr } = await supabase
    .from("accounting_entries")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
    })
    .eq("id", entryId)
  if (postErr) {
    await cancelEntry(supabase, entryId)
    return { success: false, error: postErr.message || "No se pudo registrar el asiento." }
  }

  const { error: linkErr } = await supabase
    .from("expense_payments")
    .update({ accounting_entry_id: entryId })
    .eq("id", expensePaymentId)
    .eq("pop_id", popId)
  if (linkErr) {
    return {
      success: false,
      error:
        linkErr.message ||
        "El asiento quedó registrado pero no se pudo vincular al pago. Contactá soporte.",
    }
  }

  return { success: true }
}

export async function postExpenseVoidReversals(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    expenseId: string
    entryDate: string
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const { popId, userId, expenseId, entryDate } = args

  const { data: payRows, error: payErr } = await supabase
    .from("expense_payments")
    .select("id, accounting_entry_id, reversal_accounting_entry_id")
    .eq("pop_id", popId)
    .eq("expense_id", expenseId)

  if (payErr) {
    return { success: false, error: payErr.message || "No se pudieron leer los pagos del gasto." }
  }

  for (const p of payRows || []) {
    const pid = String(p.id)
    const origId = p.accounting_entry_id != null ? String(p.accounting_entry_id) : ""
    const revId =
      p.reversal_accounting_entry_id != null
        ? String(p.reversal_accounting_entry_id)
        : ""
    if (!origId || revId) continue

    const { data: origEntry, error: oe } = await supabase
      .from("accounting_entries")
      .select("id, status, description")
      .eq("id", origId)
      .eq("pop_id", popId)
      .maybeSingle()
    if (oe || !origEntry?.id) {
      return { success: false, error: oe?.message || "Asiento original no encontrado." }
    }
    if (String(origEntry.status ?? "") !== "posted") {
      return {
        success: false,
        error: "El asiento original no está registrado; no se puede revertir.",
      }
    }

    const { data: lineRows, error: le } = await supabase
      .from("accounting_entry_lines")
      .select("account_id, debit_amount, credit_amount, description, line_order")
      .eq("entry_id", origId)
      .order("line_order", { ascending: true })
    if (le) {
      return { success: false, error: le.message || "No se pudieron leer las líneas del asiento." }
    }
    const lines = lineRows || []
    if (lines.length < 1) {
      return { success: false, error: "El asiento original no tiene líneas." }
    }

    const baseDesc = String(origEntry.description ?? "Anulación gasto")
    const revDescription = `Anulación — ${baseDesc}`

    const nextNum = await nextEntryNumber(supabase, popId)
    const { data: revIns, error: revErr } = await supabase
      .from("accounting_entries")
      .insert({
        pop_id: popId,
        entry_number: nextNum,
        entry_date: entryDate,
        source_type: "expense_void",
        source_id: pid,
        description: revDescription,
        status: "draft",
        created_by: userId,
      })
      .select("id")
      .single()

    if (revErr || !revIns?.id) {
      return {
        success: false,
        error: revErr?.message || "No se pudo crear el asiento de anulación.",
      }
    }
    const newEntryId = String(revIns.id)

    const payload = lines.map((row, i) => {
      const d = roundMoney(Number(row.debit_amount ?? 0))
      const c = roundMoney(Number(row.credit_amount ?? 0))
      return {
        entry_id: newEntryId,
        account_id: String(row.account_id),
        debit_amount: c,
        credit_amount: d,
        description: revDescription,
        line_order: i + 1,
      }
    })

    const { error: insL } = await supabase.from("accounting_entry_lines").insert(payload)
    if (insL) {
      await cancelEntry(supabase, newEntryId)
      return {
        success: false,
        error: insL.message || "No se pudieron crear las líneas de anulación.",
      }
    }

    const { error: postE } = await supabase
      .from("accounting_entries")
      .update({
        status: "posted",
        posted_at: new Date().toISOString(),
        posted_by: userId,
      })
      .eq("id", newEntryId)
    if (postE) {
      await cancelEntry(supabase, newEntryId)
      return {
        success: false,
        error: postE.message || "No se pudo registrar la anulación contable.",
      }
    }

    const { error: upPay } = await supabase
      .from("expense_payments")
      .update({ reversal_accounting_entry_id: newEntryId })
      .eq("id", pid)
      .eq("pop_id", popId)
    if (upPay) {
      return {
        success: false,
        error: upPay.message || "No se pudo vincular la anulación al pago.",
      }
    }
  }

  return { success: true }
}
