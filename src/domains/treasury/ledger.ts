import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { resolveTreasuryAccountLedgerAccountId } from "./chart.js"

const CHART_GASTOS_GENERALES = ["6.2.1.99", "6.2.1.02", "6.2.1.01"] as const
const CHART_GASTOS_FINANCIEROS = ["6.3.1.01", ...CHART_GASTOS_GENERALES] as const
const CHART_GASTOS_COMERCIALES = [
  "6.2.1.02",
  "6.3.1.01",
  ...CHART_GASTOS_GENERALES,
] as const
const CHART_TARJETAS_CREDITO_A_PAGAR = ["2.1.1.03", "2.1.1.02"] as const

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

type LedgerLine = {
  account_id: string
  debit_amount: number
  credit_amount: number
  description: string
  line_order: number
}

async function postBalancedEntry(
  supabase: SupabaseClient,
  args: {
    popId: string
    userId: string
    entryDate: string
    sourceType: string
    sourceId: string
    description: string
    lines: LedgerLine[]
  },
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const { popId, userId, entryDate, sourceType, sourceId, description, lines } =
    args

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return { success: false, error: "Fecha de asiento inválida." }
  }

  let debitTotal = 0
  let creditTotal = 0
  for (const line of lines) {
    debitTotal = roundMoney(debitTotal + line.debit_amount)
    creditTotal = roundMoney(creditTotal + line.credit_amount)
  }
  if (Math.abs(debitTotal - creditTotal) > 0.009) {
    return { success: false, error: "El asiento no balancea." }
  }

  const nextNum = await nextEntryNumber(supabase, popId)
  const { data: entIns, error: entErr } = await supabase
    .from("accounting_entries")
    .insert({
      pop_id: popId,
      entry_number: nextNum,
      entry_date: entryDate,
      source_type: sourceType,
      source_id: sourceId,
      description,
      status: "draft",
      created_by: userId,
    })
    .select("id")
    .single()

  if (entErr || !entIns?.id) {
    return { success: false, error: entErr?.message || "No se pudo crear el asiento." }
  }
  const entryId = String(entIns.id)

  const { error: linesErr } = await supabase
    .from("accounting_entry_lines")
    .insert(lines.map((line) => ({ ...line, entry_id: entryId })))

  if (linesErr) {
    await supabase
      .from("accounting_entries")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", entryId)
    return {
      success: false,
      error: linesErr.message || "No se pudieron crear las líneas.",
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
    await supabase
      .from("accounting_entries")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", entryId)
    return {
      success: false,
      error: postErr.message || "No se pudo registrar el asiento.",
    }
  }

  return { success: true, entryId }
}

export async function postTreasurySettlementLedger(
  supabase: SupabaseClient,
  args: { popId: string; userId: string; settlementId: string },
): Promise<{ success: true } | { success: false; error: string }> {
  const { popId, userId, settlementId } = args

  const { data: row, error: rowErr } = await supabase
    .from("treasury_settlements")
    .select(
      "id, amount, principal_amount, adjustment_amount, settled_at, notes, card_treasury_account_id, funding_treasury_account_id, accounting_entry_id",
    )
    .eq("id", settlementId)
    .eq("pop_id", popId)
    .maybeSingle()

  if (rowErr || !row) {
    return { success: false, error: "Liquidación de tesorería no encontrada." }
  }
  if (row.accounting_entry_id) return { success: true }

  const principal = roundMoney(parseMoney(row.principal_amount ?? row.amount))
  const adjustment = roundMoney(parseMoney(row.adjustment_amount ?? 0))
  const bankOut = roundMoney(principal + adjustment)
  if (!(principal > 0)) {
    return { success: false, error: "Importe de liquidación inválido." }
  }

  const entryDate = String(row.settled_at ?? "").slice(0, 10)
  const cardTaId =
    row.card_treasury_account_id != null
      ? String(row.card_treasury_account_id)
      : null
  const fundTaId =
    row.funding_treasury_account_id != null
      ? String(row.funding_treasury_account_id)
      : null

  let cardLabel = "Tarjeta"
  if (cardTaId) {
    const { data: cardTa } = await supabase
      .from("treasury_accounts")
      .select("name")
      .eq("id", cardTaId)
      .eq("pop_id", popId)
      .maybeSingle()
    cardLabel = String(cardTa?.name ?? "Tarjeta").trim()
  }
  const entryDescription = `Pago resumen tarjeta — ${cardLabel}`

  let liabilityAccountId = cardTaId
    ? await resolveTreasuryAccountLedgerAccountId(supabase, popId, cardTaId)
    : null
  if (!liabilityAccountId) {
    liabilityAccountId = await resolveAccountId(
      supabase,
      popId,
      CHART_TARJETAS_CREDITO_A_PAGAR,
    )
  }
  if (!liabilityAccountId) {
    return {
      success: false,
      error: "No hay cuenta Tarjetas de crédito a pagar en el plan de cuentas.",
    }
  }

  const bankAccountId = fundTaId
    ? await resolveTreasuryAccountLedgerAccountId(supabase, popId, fundTaId)
    : null
  if (!bankAccountId) {
    return {
      success: false,
      error:
        "Configurá una cuenta contable en la cuenta de tesorería usada para pagar el resumen.",
    }
  }

  const lines: LedgerLine[] = [
    {
      account_id: liabilityAccountId,
      debit_amount: principal,
      credit_amount: 0,
      description: entryDescription,
      line_order: 1,
    },
  ]

  if (adjustment > 0) {
    const expenseAccountId = await resolveAccountId(
      supabase,
      popId,
      CHART_GASTOS_FINANCIEROS,
    )
    if (!expenseAccountId) {
      return {
        success: false,
        error:
          "No hay cuenta de gastos financieros para registrar cargos del resumen.",
      }
    }
    lines.push({
      account_id: expenseAccountId,
      debit_amount: adjustment,
      credit_amount: 0,
      description: `${entryDescription} — intereses y otros cargos del resumen`,
      line_order: 2,
    })
  }

  lines.push({
    account_id: bankAccountId,
    debit_amount: 0,
    credit_amount: bankOut,
    description: entryDescription,
    line_order: lines.length + 1,
  })

  const posted = await postBalancedEntry(supabase, {
    popId,
    userId,
    entryDate,
    sourceType: "treasury_settlement",
    sourceId: settlementId,
    description: entryDescription,
    lines,
  })
  if (!posted.success) return posted

  const { error: linkErr } = await supabase
    .from("treasury_settlements")
    .update({ accounting_entry_id: posted.entryId })
    .eq("id", settlementId)
    .eq("pop_id", popId)
  if (linkErr) {
    return {
      success: false,
      error:
        linkErr.message ||
        "El asiento quedó registrado pero no se pudo vincular a la liquidación.",
    }
  }
  return { success: true }
}

export async function postPosAcreditationLedger(
  supabase: SupabaseClient,
  args: { popId: string; userId: string; acreditationId: string },
): Promise<{ success: true } | { success: false; error: string }> {
  const { popId, userId, acreditationId } = args

  const { data: row, error: rowErr } = await supabase
    .from("treasury_pos_acreditations")
    .select(
      "id, principal_amount, adjustment_amount, credited_at, notes, pos_treasury_account_id, mother_treasury_account_id, accounting_entry_id",
    )
    .eq("id", acreditationId)
    .eq("pop_id", popId)
    .maybeSingle()

  if (rowErr || !row) {
    return { success: false, error: "Acreditación POS no encontrada." }
  }
  if (row.accounting_entry_id) return { success: true }

  const principal = roundMoney(parseMoney(row.principal_amount))
  const adjustment = roundMoney(parseMoney(row.adjustment_amount ?? 0))
  const posCredit = roundMoney(principal + adjustment)
  if (!(principal > 0)) {
    return { success: false, error: "Importe de acreditación inválido." }
  }

  const entryDate = String(row.credited_at ?? "").slice(0, 10)
  const posTaId = String(row.pos_treasury_account_id)
  const motherTaId = String(row.mother_treasury_account_id)

  const { data: posTa } = await supabase
    .from("treasury_accounts")
    .select("name")
    .eq("id", posTaId)
    .eq("pop_id", popId)
    .maybeSingle()
  const posName = String(posTa?.name ?? "POS").trim()
  const notes = String(row.notes ?? "").trim()
  const entryDescription = notes
    ? `Acreditación POS — ${posName} (${notes})`
    : `Acreditación POS — ${posName}`

  const posLedgerId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    posTaId,
  )
  const bankLedgerId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    motherTaId,
  )
  if (!posLedgerId || !bankLedgerId) {
    return {
      success: false,
      error: "No se encontraron las cuentas contables vinculadas.",
    }
  }

  const lines: LedgerLine[] = [
    {
      account_id: bankLedgerId,
      debit_amount: principal,
      credit_amount: 0,
      description: entryDescription,
      line_order: 1,
    },
  ]

  if (adjustment > 0) {
    const expenseAccountId = await resolveAccountId(
      supabase,
      popId,
      CHART_GASTOS_COMERCIALES,
    )
    if (!expenseAccountId) {
      return {
        success: false,
        error: "No hay cuenta de gastos para registrar comisiones e impuestos.",
      }
    }
    lines.push({
      account_id: expenseAccountId,
      debit_amount: adjustment,
      credit_amount: 0,
      description: `${entryDescription} — comisiones e impuestos`,
      line_order: 2,
    })
  }

  lines.push({
    account_id: posLedgerId,
    debit_amount: 0,
    credit_amount: posCredit,
    description: entryDescription,
    line_order: lines.length + 1,
  })

  const posted = await postBalancedEntry(supabase, {
    popId,
    userId,
    entryDate,
    sourceType: "treasury_pos_acreditation",
    sourceId: acreditationId,
    description: entryDescription,
    lines,
  })
  if (!posted.success) return posted

  const { error: linkErr } = await supabase
    .from("treasury_pos_acreditations")
    .update({ accounting_entry_id: posted.entryId })
    .eq("id", acreditationId)
    .eq("pop_id", popId)
  if (linkErr) {
    return {
      success: false,
      error:
        linkErr.message ||
        "El asiento quedó registrado pero no se pudo vincular a la acreditación.",
    }
  }
  return { success: true }
}
