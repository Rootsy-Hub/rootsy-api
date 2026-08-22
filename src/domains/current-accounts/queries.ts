import type { SupabaseClient } from "@supabase/supabase-js"
import {
  currentAccountAvailableCredit,
  currentAccountAgingBucket,
  currentAccountDaysOverdue,
  currentAccountDocumentKindForDirection,
  currentAccountDocumentLabel,
  escapeIlikeToken,
  isValidOperationPaymentKind,
  normalizeCurrentAccountCreditLimit,
  normalizeCurrentAccountTermDays,
  operationPaymentKindLabel,
  roundMoney,
} from "./accounts.js"
import {
  compareLedgerWhen,
  emptyPartyRow,
  fillMissingPartyNames,
  groupParties,
  ledgerOccurredAt,
  loadEnrolledParties,
  loadOpenDocuments,
  loadPopTimeZone,
  loadUnappliedByParty,
  mergeEnrolledParties,
  sortParties,
} from "./documents.js"
import type {
  CurrentAccountDirection,
  CurrentAccountEnrollmentCandidate,
  CurrentAccountLedgerData,
  CurrentAccountLedgerLine,
  CurrentAccountListData,
  CurrentAccountOpenDocument,
  ListCurrentAccountsQuery,
} from "./schema.js"
import { toPopCalendarDate } from "./timezone.js"

function treasuryAccountNameFromRel(raw: unknown): string {
  if (raw == null) return ""
  const row = Array.isArray(raw) ? raw[0] : raw
  if (row == null || typeof row !== "object") return ""
  return String((row as { name?: unknown }).name ?? "").trim()
}

function currentAccountPaymentDescription(
  paymentKind: string,
  treasuryName: string,
  notes?: string,
): string {
  const kindLabel = operationPaymentKindLabel(paymentKind)
  const account = treasuryName.trim()
  const base =
    kindLabel && account ? `${kindLabel} · ${account}` : kindLabel || account
  const extra = notes?.trim() ?? ""
  if (extra && extra !== base && extra !== kindLabel && extra !== account) {
    return `${base} · ${extra}`
  }
  return base || "—"
}

export async function listCurrentAccountParties(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  input: ListCurrentAccountsQuery,
): Promise<
  { success: true; data: CurrentAccountListData } | { success: false; error: string }
> {
  const timeZone = await loadPopTimeZone(supabase, popId, siteId)
  const today = toPopCalendarDate(new Date().toISOString(), timeZone)
  const documents = await loadOpenDocuments(supabase, popId, input.direction, timeZone)
  const unapplied = await loadUnappliedByParty(supabase, popId, input.direction)
  const enrolled = await loadEnrolledParties(supabase, popId, input.direction)
  let parties = mergeEnrolledParties(
    groupParties(documents, today, unapplied),
    enrolled,
  )
  await fillMissingPartyNames(supabase, input.direction, parties)
  const q = input.search.toLowerCase()
  if (q) {
    parties = parties.filter((row) => row.partyName.toLowerCase().includes(q))
  }
  if (input.aging !== "all") {
    const aging = input.aging
    parties = parties.filter((row) => row.aging[aging] > 0.009)
  }
  parties = sortParties(
    parties,
    input.sort ?? "balance",
    input.sort ? input.ord === "asc" : false,
  )
  const totalCount = parties.length
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  return {
    success: true,
    data: {
      parties: parties.slice(from, from + input.pageSize),
      totalCount,
      page,
      pageSize: input.pageSize,
      direction: input.direction,
    },
  }
}

export async function getCurrentAccountLedger(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  direction: CurrentAccountDirection,
  partyId: string,
): Promise<
  | { success: true; data: CurrentAccountLedgerData }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const timeZone = await loadPopTimeZone(supabase, popId, siteId)
  const today = toPopCalendarDate(new Date().toISOString(), timeZone)
  const documents = await loadOpenDocuments(
    supabase,
    popId,
    direction,
    timeZone,
    partyId,
  )
  const unapplied = await loadUnappliedByParty(supabase, popId, direction, partyId)
  const grouped = groupParties(documents, today, unapplied)
  await fillMissingPartyNames(supabase, direction, grouped)
  const table = direction === "receivable" ? "clients" : "suppliers"
  const { data: partyRow } = await supabase
    .from(table)
    .select(
      "id, name, current_account_enabled, current_account_credit_limit, current_account_term_days",
    )
    .eq("id", partyId)
    .maybeSingle()
  const enrolled = partyRow?.current_account_enabled === true
  const creditLimit = normalizeCurrentAccountCreditLimit(
    partyRow?.current_account_credit_limit,
  )
  const termDays = normalizeCurrentAccountTermDays(
    partyRow?.current_account_term_days,
  )
  let summary = grouped[0]
  if (!summary) {
    if (!partyRow) {
      return {
        success: false,
        error:
          direction === "receivable"
            ? "No se encontró el cliente."
            : "No se encontró el proveedor.",
        status: 404,
      }
    }
    summary = emptyPartyRow(
      partyId,
      String(partyRow.name ?? "").trim() || "—",
      enrolled,
    )
  } else {
    summary.enrolled = enrolled
    if (!summary.partyName.trim() && partyRow?.name) {
      summary.partyName = String(partyRow.name).trim()
    }
  }

  const kind = currentAccountDocumentKindForDirection(direction)
  const documentIds = documents.map((doc) => doc.id)
  const paymentTable = kind === "sale" ? "sale_payments" : "purchase_payments"
  const paymentFk = kind === "sale" ? "sale_id" : "purchase_id"
  const paymentSelect =
    kind === "sale"
      ? "sale_id, amount, payment_kind, created_at, treasury_account_id, treasury_accounts ( name )"
      : "purchase_id, amount, payment_kind, created_at, paid_at, treasury_account_id, treasury_accounts ( name )"
  const payRows =
    documentIds.length === 0
      ? []
      : (((
          await supabase
            .from(paymentTable)
            .select(paymentSelect)
            .eq("pop_id", popId)
            .is("reversed_at", null)
            .in(paymentFk, documentIds)
        ).data ?? []) as unknown[])

  const receiptQuery =
    direction === "receivable"
      ? supabase
          .from("current_account_receipts")
          .select(
            "id, amount, paid_at, created_at, payment_kind, notes, treasury_account_id, treasury_accounts ( name )",
          )
          .eq("pop_id", popId)
          .eq("client_id", partyId)
      : supabase
          .from("current_account_receipts")
          .select(
            "id, amount, paid_at, created_at, payment_kind, notes, treasury_account_id, treasury_accounts ( name )",
          )
          .eq("pop_id", popId)
          .eq("supplier_id", partyId)
  const { data: receiptRows } = await receiptQuery

  type DraftLine = Omit<CurrentAccountLedgerLine, "balance">
  const drafts: DraftLine[] = []
  const isReceivable = direction === "receivable"

  for (const doc of documents) {
    const label = currentAccountDocumentLabel(kind, doc.documentNumber)
    drafts.push({
      id: `doc-${doc.id}`,
      date: doc.date,
      occurredAt: doc.occurredAt,
      documentLabel: label,
      description: label,
      paymentKindLabel: null,
      debit: isReceivable ? doc.total : 0,
      credit: isReceivable ? 0 : doc.total,
    })
  }

  for (const row of payRows) {
    const raw = row as Record<string, unknown>
    const amount = Number(raw.amount ?? 0) || 0
    if (!(amount > 0)) continue
    const paidAt =
      raw.paid_at != null
        ? toPopCalendarDate(String(raw.paid_at), timeZone)
        : toPopCalendarDate(String(raw.created_at ?? ""), timeZone)
    drafts.push({
      id: `pay-${String(raw[paymentFk])}-${paidAt}-${amount}`,
      date: paidAt,
      occurredAt: ledgerOccurredAt(raw.created_at ?? raw.paid_at),
      documentLabel: kind === "sale" ? "Cobro" : "Pago",
      description: currentAccountPaymentDescription(
        String(raw.payment_kind ?? ""),
        treasuryAccountNameFromRel(raw.treasury_accounts),
      ),
      paymentKindLabel: isValidOperationPaymentKind(String(raw.payment_kind ?? ""))
        ? operationPaymentKindLabel(String(raw.payment_kind ?? ""))
        : null,
      debit: isReceivable ? 0 : amount,
      credit: isReceivable ? amount : 0,
    })
  }

  for (const row of receiptRows ?? []) {
    const amount = Number(row.amount ?? 0) || 0
    if (!(amount > 0)) continue
    const notes = String(row.notes ?? "").trim()
    drafts.push({
      id: `receipt-${String(row.id)}`,
      date: toPopCalendarDate(String(row.paid_at ?? ""), timeZone),
      occurredAt: ledgerOccurredAt((row as { created_at?: unknown }).created_at),
      documentLabel: direction === "receivable" ? "Recibo" : "Orden de pago",
      description: currentAccountPaymentDescription(
        String(row.payment_kind ?? ""),
        treasuryAccountNameFromRel(
          (row as { treasury_accounts?: unknown }).treasury_accounts,
        ),
        notes,
      ),
      paymentKindLabel: isValidOperationPaymentKind(String(row.payment_kind ?? ""))
        ? operationPaymentKindLabel(String(row.payment_kind ?? ""))
        : null,
      debit: isReceivable ? 0 : amount,
      credit: isReceivable ? amount : 0,
    })
  }

  drafts.sort(compareLedgerWhen)
  let running = 0
  const lines: CurrentAccountLedgerLine[] = drafts
    .map((line) => {
      running = roundMoney(running + line.debit - line.credit)
      return { ...line, balance: running }
    })
    .reverse()

  const openDocuments: CurrentAccountOpenDocument[] = documents
    .filter((doc) => doc.remaining > 0.009)
    .map((doc) => ({
      id: doc.id,
      date: doc.date,
      occurredAt: doc.occurredAt,
      dueDate: doc.dueDate,
      documentLabel: currentAccountDocumentLabel(kind, doc.documentNumber),
      remaining: doc.remaining,
      daysOverdue: currentAccountDaysOverdue(doc.dueDate, today),
      agingBucket: currentAccountAgingBucket(doc.dueDate, today),
    }))
    .sort((a, b) => compareLedgerWhen(b, a))

  return {
    success: true,
    data: {
      partyName: summary.partyName || "—",
      balance: summary.balance,
      openCount: summary.openCount,
      overdueAmount: summary.overdueAmount,
      aging: summary.aging,
      lines,
      openDocuments,
      unappliedCredit: unapplied.get(partyId) ?? 0,
      enrolled,
      creditLimit,
      termDays,
      availableCredit: currentAccountAvailableCredit(creditLimit, summary.balance),
    },
  }
}

export async function searchEnrollmentCandidates(
  supabase: SupabaseClient,
  popId: string,
  direction: CurrentAccountDirection,
  query: string,
): Promise<
  | { success: true; data: { parties: CurrentAccountEnrollmentCandidate[] } }
  | { success: false; error: string }
> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { success: true, data: { parties: [] } }
  }
  const table = direction === "receivable" ? "clients" : "suppliers"
  const pattern = `%${escapeIlikeToken(trimmed)}%`
  const { data, error } = await supabase
    .from(table)
    .select("id, name, tax_id")
    .eq("pop_id", popId)
    .eq("current_account_enabled", false)
    .eq("is_active", true)
    .or(`name.ilike.${pattern},tax_id.ilike.${pattern}`)
    .order("name", { ascending: true })
    .limit(30)
  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: {
      parties: (data ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.name ?? "").trim() || "—",
        taxId:
          row.tax_id != null && String(row.tax_id).trim()
            ? String(row.tax_id).trim()
            : null,
      })),
    },
  }
}
