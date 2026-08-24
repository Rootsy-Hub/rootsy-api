import type { SupabaseClient } from "@supabase/supabase-js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
  type LedgerLineOp,
} from "../../audit/ledgerOps.js"
import type { AuditOp } from "../../audit/types.js"
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
  return nextAccountingEntryNumber(supabase, popId)
}

type LedgerLine = LedgerLineOp

type LedgerBuildResult =
  | { success: true; entryId: string; ops: AuditOp[] }
  | { success: false; error: string }

async function buildBalancedEntryOps(
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
): Promise<LedgerBuildResult> {
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
  const ledger = postedAccountingEntryOps({
    popId,
    userId,
    entryNumber: nextNum,
    entryDate,
    sourceType,
    sourceId,
    description,
    lines,
  })
  return { success: true, entryId: ledger.entryId, ops: ledger.ops }
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

export async function buildCheckReceiveLedgerOps(
  supabase: SupabaseClient,
  args: LedgerArgs,
): Promise<LedgerBuildResult> {
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

  return buildBalancedEntryOps(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_receive",
    sourceId: args.checkId,
    description,
    lines,
  })
}

export async function buildCheckDepositLedgerOps(
  supabase: SupabaseClient,
  args: LedgerArgs & { treasuryAccountId: string },
): Promise<LedgerBuildResult> {
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

  return buildBalancedEntryOps(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_deposit",
    sourceId: args.checkId,
    description,
    lines,
  })
}

export async function buildCheckRejectLedgerOps(
  supabase: SupabaseClient,
  args: LedgerArgs & {
    settledToBank: boolean
    treasuryAccountId?: string | null
  },
): Promise<LedgerBuildResult> {
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

  return buildBalancedEntryOps(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_reject",
    sourceId: args.checkId,
    description,
    lines,
  })
}

export async function buildCheckVoidLedgerOps(
  supabase: SupabaseClient,
  args: LedgerArgs,
): Promise<LedgerBuildResult> {
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

  return buildBalancedEntryOps(supabase, {
    popId: args.popId,
    userId: args.userId,
    entryDate: args.entryDate,
    sourceType: "check_void",
    sourceId: args.checkId,
    description,
    lines,
  })
}

const LINKED_PAYMENT_TABLES = [
  "expense_payments",
  "sale_payments",
  "purchase_payments",
  "service_charge_payments",
] as const

export async function buildCheckLinkedReversalOps(
  supabase: SupabaseClient,
  popId: string,
  checkId: string,
): Promise<{ success: true; ops: AuditOp[] } | { success: false; error: string }> {
  const reversedAt = new Date().toISOString()
  const ops: AuditOp[] = []

  for (const table of LINKED_PAYMENT_TABLES) {
    const { data: rows, error } = await supabase
      .from(table)
      .select("id")
      .eq("pop_id", popId)
      .eq("check_id", checkId)
      .is("reversed_at", null)
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudo reabrir el comprobante del cheque.",
      }
    }
    for (const row of rows ?? []) {
      ops.push({
        op: "update",
        table,
        id: String(row.id),
        row: { reversed_at: reversedAt },
      })
    }
  }

  const { data: receipts, error: recErr } = await supabase
    .from("current_account_receipts")
    .select("id")
    .eq("pop_id", popId)
    .eq("check_id", checkId)
  if (recErr) {
    return {
      success: false,
      error:
        recErr.message ||
        "No se pudo reabrir el comprobante de cuenta corriente.",
    }
  }
  for (const row of receipts ?? []) {
    ops.push({
      op: "delete",
      table: "current_account_receipts",
      id: String(row.id),
    })
  }
  return { success: true, ops }
}
