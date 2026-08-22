import type { SupabaseClient } from "@supabase/supabase-js"
import type { CheckDirection } from "./schema.js"

const CHART_CUENTAS_POR_COBRAR_CODES = ["1.1.2.01"] as const
const CHART_DOCUMENTOS_POR_COBRAR_CODES = ["1.1.2.02"] as const
const CHART_PROVEEDORES_CC_CODES = ["2.1.1.01"] as const
const CHART_DOCUMENTOS_A_PAGAR_CODES = ["2.1.1.02"] as const

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
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

export async function cancelCheckAccountingEntry(
  supabase: SupabaseClient,
  entryId: string,
): Promise<void> {
  await supabase
    .from("accounting_entries")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", entryId)
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
    await cancelCheckAccountingEntry(supabase, entryId)
    return { success: false, error: linesErr.message || "No se pudieron crear las líneas." }
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
    await cancelCheckAccountingEntry(supabase, entryId)
    return { success: false, error: postErr.message || "No se pudo registrar el asiento." }
  }

  return { success: true, entryId }
}

async function resolveCheckTreasuryAccountId(
  supabase: SupabaseClient,
  popId: string,
  direction: CheckDirection,
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

async function resolveDocumentsAccountId(
  supabase: SupabaseClient,
  popId: string,
  direction: CheckDirection,
): Promise<string | null> {
  const treasuryId = await resolveCheckTreasuryAccountId(supabase, popId, direction)
  if (treasuryId) {
    const fromTreasury = await resolveTreasuryAccountLedgerAccountId(
      supabase,
      popId,
      treasuryId,
    )
    if (fromTreasury) return fromTreasury
  }
  return resolveAccountId(
    supabase,
    popId,
    direction === "issued"
      ? CHART_DOCUMENTOS_A_PAGAR_CODES
      : CHART_DOCUMENTOS_POR_COBRAR_CODES,
  )
}

async function resolvePartyAccountId(
  supabase: SupabaseClient,
  popId: string,
  direction: CheckDirection,
): Promise<string | null> {
  return resolveAccountId(
    supabase,
    popId,
    direction === "issued"
      ? CHART_PROVEEDORES_CC_CODES
      : CHART_CUENTAS_POR_COBRAR_CODES,
  )
}

function checkEntryDescription(
  actionLabel: string,
  checkNumber: string,
  bankName: string,
): string {
  const number = checkNumber.trim() || "s/n"
  const bank = bankName.trim()
  return bank
    ? `${actionLabel} — cheque ${number} · ${bank}`
    : `${actionLabel} — cheque ${number}`
}

type LedgerArgs = {
  popId: string
  userId: string
  checkId: string
  direction: CheckDirection
  amount: number
  entryDate: string
  checkNumber: string
  bankName: string
}

export async function postCheckReceiveLedger(
  supabase: SupabaseClient,
  args: LedgerArgs,
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const amount = roundMoney(args.amount)
  if (!(amount > 0)) {
    return { success: false, error: "Importe de cheque inválido." }
  }

  const documentsId = await resolveDocumentsAccountId(
    supabase,
    args.popId,
    args.direction,
  )
  const partyId = await resolvePartyAccountId(supabase, args.popId, args.direction)
  if (!documentsId || !partyId) {
    return {
      success: false,
      error:
        args.direction === "issued"
          ? "Falta Documentos a pagar o Proveedores en el plan de cuentas."
          : "Falta Documentos por cobrar o Cuentas por cobrar en el plan de cuentas.",
    }
  }

  const description = checkEntryDescription(
    args.direction === "issued" ? "Cheque emitido" : "Cheque recibido",
    args.checkNumber,
    args.bankName,
  )

  const lines: LedgerLine[] =
    args.direction === "issued"
      ? [
          {
            account_id: partyId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: documentsId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]
      : [
          {
            account_id: documentsId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: partyId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]

  return postBalancedEntry(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_receive",
    sourceId: args.checkId,
    description,
    lines,
  })
}

export async function postCheckDepositLedger(
  supabase: SupabaseClient,
  args: LedgerArgs & { treasuryAccountId: string },
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const amount = roundMoney(args.amount)
  if (!(amount > 0)) {
    return { success: false, error: "Importe de cheque inválido." }
  }

  const documentsId = await resolveDocumentsAccountId(
    supabase,
    args.popId,
    args.direction,
  )
  if (!documentsId) {
    return {
      success: false,
      error:
        args.direction === "issued"
          ? "Falta Documentos a pagar en el plan de cuentas."
          : "Falta Documentos por cobrar en el plan de cuentas.",
    }
  }

  const bankId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    args.popId,
    args.treasuryAccountId,
  )
  if (!bankId) {
    return {
      success: false,
      error: "Configurá una cuenta contable en el banco o billetera elegido.",
    }
  }

  const description = checkEntryDescription(
    args.direction === "issued" ? "Débito de cheque" : "Depósito de cheque",
    args.checkNumber,
    args.bankName,
  )

  const lines: LedgerLine[] =
    args.direction === "issued"
      ? [
          {
            account_id: documentsId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: bankId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]
      : [
          {
            account_id: bankId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: documentsId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]

  return postBalancedEntry(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_deposit",
    sourceId: args.checkId,
    description,
    lines,
  })
}

export async function postCheckRejectLedger(
  supabase: SupabaseClient,
  args: LedgerArgs & {
    settledToBank: boolean
    treasuryAccountId?: string | null
  },
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const amount = roundMoney(args.amount)
  if (!(amount > 0)) {
    return { success: false, error: "Importe de cheque inválido." }
  }

  const partyId = await resolvePartyAccountId(supabase, args.popId, args.direction)
  if (!partyId) {
    return {
      success: false,
      error:
        args.direction === "issued"
          ? "Falta Proveedores en el plan de cuentas."
          : "Falta Cuentas por cobrar en el plan de cuentas.",
    }
  }

  let counterpartId: string | null = null
  if (args.settledToBank) {
    const treasuryAccountId = args.treasuryAccountId?.trim() || ""
    if (!treasuryAccountId) {
      return {
        success: false,
        error: "Este cheque no tiene banco de depósito para revertir el asiento.",
      }
    }
    counterpartId = await resolveTreasuryAccountLedgerAccountId(
      supabase,
      args.popId,
      treasuryAccountId,
    )
    if (!counterpartId) {
      return {
        success: false,
        error: "Configurá una cuenta contable en el banco o billetera del depósito.",
      }
    }
  } else {
    counterpartId = await resolveDocumentsAccountId(
      supabase,
      args.popId,
      args.direction,
    )
    if (!counterpartId) {
      return {
        success: false,
        error:
          args.direction === "issued"
            ? "Falta Documentos a pagar en el plan de cuentas."
            : "Falta Documentos por cobrar en el plan de cuentas.",
      }
    }
  }

  const description = checkEntryDescription(
    "Rechazo de cheque",
    args.checkNumber,
    args.bankName,
  )

  const lines: LedgerLine[] =
    args.direction === "issued"
      ? [
          {
            account_id: counterpartId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: partyId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]
      : [
          {
            account_id: partyId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: counterpartId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]

  return postBalancedEntry(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_reject",
    sourceId: args.checkId,
    description,
    lines,
  })
}

export async function postCheckVoidLedger(
  supabase: SupabaseClient,
  args: LedgerArgs,
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const amount = roundMoney(args.amount)
  if (!(amount > 0)) {
    return { success: false, error: "Importe de cheque inválido." }
  }

  const documentsId = await resolveDocumentsAccountId(
    supabase,
    args.popId,
    args.direction,
  )
  const partyId = await resolvePartyAccountId(supabase, args.popId, args.direction)
  if (!documentsId || !partyId) {
    return {
      success: false,
      error:
        args.direction === "issued"
          ? "Falta Documentos a pagar o Proveedores en el plan de cuentas."
          : "Falta Documentos por cobrar o Cuentas por cobrar en el plan de cuentas.",
    }
  }

  const description = checkEntryDescription(
    "Anulación de cheque",
    args.checkNumber,
    args.bankName,
  )

  const lines: LedgerLine[] =
    args.direction === "issued"
      ? [
          {
            account_id: documentsId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: partyId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]
      : [
          {
            account_id: partyId,
            debit_amount: amount,
            credit_amount: 0,
            description,
            line_order: 1,
          },
          {
            account_id: documentsId,
            debit_amount: 0,
            credit_amount: amount,
            description,
            line_order: 2,
          },
        ]

  return postBalancedEntry(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_void",
    sourceId: args.checkId,
    description,
    lines,
  })
}

const PAYMENT_TABLES = [
  "sale_payments",
  "purchase_payments",
  "expense_payments",
  "service_charge_payments",
] as const

export async function reversePaymentsLinkedToCheck(
  supabase: SupabaseClient,
  popId: string,
  checkId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const reversedAt = new Date().toISOString()
  for (const table of PAYMENT_TABLES) {
    const { error } = await supabase
      .from(table)
      .update({ reversed_at: reversedAt })
      .eq("pop_id", popId)
      .eq("check_id", checkId)
      .is("reversed_at", null)
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudo reabrir el comprobante del cheque.",
      }
    }
  }

  const { error: receiptErr } = await supabase
    .from("current_account_receipts")
    .delete()
    .eq("pop_id", popId)
    .eq("check_id", checkId)
  if (receiptErr) {
    return {
      success: false,
      error:
        receiptErr.message ||
        "No se pudo reabrir el comprobante de cuenta corriente.",
    }
  }

  return { success: true }
}
