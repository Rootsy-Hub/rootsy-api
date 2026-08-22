import type { SupabaseClient } from "@supabase/supabase-js"
import {
  addCurrentAccountAgingAmount,
  CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS,
  currentAccountAgingBucket,
  currentAccountDocumentKindForDirection,
  currentAccountIsOpen,
  currentAccountOpenAmount,
  emptyCurrentAccountAgingTotals,
  normalizeCurrentAccountCreditLimit,
  normalizeCurrentAccountTermDays,
  roundMoney,
} from "./accounts.js"
import type {
  CurrentAccountDirection,
  CurrentAccountDocumentKind,
  CurrentAccountPartyRow,
  CurrentAccountTableSortKey,
} from "./schema.js"
import {
  isCalendarDateOnly,
  timezoneForPopLedger,
  toPopCalendarDate,
} from "./timezone.js"

export type DocumentOpenItem = {
  id: string
  partyId: string
  partyName: string
  total: number
  remaining: number
  dueDate: string
  date: string
  occurredAt: string | null
  documentNumber: string
  includedInLedger: boolean
}

export function ledgerOccurredAt(raw: unknown): string | null {
  const value = String(raw ?? "").trim()
  if (!value || isCalendarDateOnly(value)) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

export function compareLedgerWhen(
  a: { date: string; occurredAt: string | null; id: string },
  b: { date: string; occurredAt: string | null; id: string },
): number {
  const byDate = a.date.localeCompare(b.date)
  if (byDate !== 0) return byDate
  const timeA = a.occurredAt ?? ""
  const timeB = b.occurredAt ?? ""
  if (timeA && timeB) {
    const byTime = timeA.localeCompare(timeB)
    if (byTime !== 0) return byTime
  } else if (timeA) {
    return 1
  } else if (timeB) {
    return -1
  }
  return a.id.localeCompare(b.id)
}

export async function loadAllocatedByDocument(
  supabase: SupabaseClient,
  popId: string,
  kind: CurrentAccountDocumentKind,
  documentIds: string[],
): Promise<Map<string, number>> {
  const allocated = new Map<string, number>()
  if (documentIds.length === 0) return allocated

  const paymentTable = kind === "sale" ? "sale_payments" : "purchase_payments"
  const paymentFk = kind === "sale" ? "sale_id" : "purchase_id"

  const { data: payRows } = await supabase
    .from(paymentTable)
    .select(`${paymentFk}, amount`)
    .eq("pop_id", popId)
    .is("reversed_at", null)
    .in(paymentFk, documentIds)

  for (const row of payRows ?? []) {
    const raw = row as Record<string, unknown>
    const id = String(raw[paymentFk] ?? "")
    if (!id) continue
    allocated.set(id, roundMoney((allocated.get(id) ?? 0) + Number(raw.amount ?? 0)))
  }

  const { data: appRows } = await supabase
    .from("current_account_applications")
    .select("document_id, amount")
    .eq("pop_id", popId)
    .eq("document_kind", kind)
    .in("document_id", documentIds)

  for (const row of appRows ?? []) {
    const id = String(row.document_id ?? "")
    if (!id) continue
    allocated.set(id, roundMoney((allocated.get(id) ?? 0) + Number(row.amount ?? 0)))
  }

  return allocated
}

export async function loadOpenDocuments(
  supabase: SupabaseClient,
  popId: string,
  direction: CurrentAccountDirection,
  timeZone: string,
  partyId?: string,
): Promise<DocumentOpenItem[]> {
  const kind = currentAccountDocumentKindForDirection(direction)

  if (kind === "sale") {
    let query = supabase
      .from("sales")
      .select(
        "id, client_id, customer_name, total, sold_at, due_date, on_account, status, clients!client_id ( name )",
      )
      .eq("pop_id", popId)
      .not("client_id", "is", null)
      .neq("status", "cancelled")
    if (partyId) query = query.eq("client_id", partyId)
    const { data } = await query
    const rows = data ?? []
    const ids = rows.map((row) => String(row.id))
    const allocated = await loadAllocatedByDocument(supabase, popId, "sale", ids)
    return rows.flatMap((row) => {
      const id = String(row.id)
      const total = Number(row.total ?? 0) || 0
      const remaining = currentAccountOpenAmount(total, allocated.get(id) ?? 0)
      const onAccount = Boolean(row.on_account)
      if (!onAccount && !currentAccountIsOpen(total, allocated.get(id) ?? 0)) {
        return []
      }
      const clients = row.clients as { name?: string } | { name?: string }[] | null
      const clientName = Array.isArray(clients) ? clients[0]?.name : clients?.name
      const date = toPopCalendarDate(String(row.sold_at ?? ""), timeZone)
      const rawDue = String(row.due_date ?? "").slice(0, 10)
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : date
      return [
        {
          id,
          partyId: String(row.client_id),
          partyName: String(clientName || row.customer_name || "").trim() || "Cliente",
          total,
          remaining,
          dueDate,
          date,
          occurredAt: ledgerOccurredAt(row.sold_at),
          documentNumber: "",
          includedInLedger: true,
        },
      ]
    })
  }

  let query = supabase
    .from("purchases")
    .select(
      "id, supplier_id, supplier_name, total, document_number, document_date, due_date, created_at, on_account, status, suppliers!supplier_id ( name )",
    )
    .eq("pop_id", popId)
    .not("supplier_id", "is", null)
    .neq("status", "voided")
  if (partyId) query = query.eq("supplier_id", partyId)
  const { data } = await query
  const rows = data ?? []
  const ids = rows.map((row) => String(row.id))
  const allocated = await loadAllocatedByDocument(supabase, popId, "purchase", ids)
  return rows.flatMap((row) => {
    const id = String(row.id)
    const total = Number(row.total ?? 0) || 0
    const remaining = currentAccountOpenAmount(total, allocated.get(id) ?? 0)
    const onAccount = Boolean(row.on_account)
    if (!onAccount && !currentAccountIsOpen(total, allocated.get(id) ?? 0)) {
      return []
    }
    const suppliers = row.suppliers as { name?: string } | { name?: string }[] | null
    const supplierName = Array.isArray(suppliers) ? suppliers[0]?.name : suppliers?.name
    const date = toPopCalendarDate(
      String(row.document_date || row.created_at || ""),
      timeZone,
    )
    const dueDate = toPopCalendarDate(
      String(row.due_date || row.document_date || row.created_at || ""),
      timeZone,
    )
    return [
      {
        id,
        partyId: String(row.supplier_id),
        partyName: String(supplierName || row.supplier_name || "").trim() || "Proveedor",
        total,
        remaining,
        dueDate,
        date,
        occurredAt: ledgerOccurredAt(row.created_at),
        documentNumber: String(row.document_number ?? "").trim(),
        includedInLedger: true,
      },
    ]
  })
}

export async function loadUnappliedByParty(
  supabase: SupabaseClient,
  popId: string,
  direction: CurrentAccountDirection,
  partyId?: string,
): Promise<Map<string, number>> {
  let query =
    direction === "receivable"
      ? supabase
          .from("current_account_receipts")
          .select("id, amount, client_id")
          .eq("pop_id", popId)
          .eq("direction", "receivable")
      : supabase
          .from("current_account_receipts")
          .select("id, amount, supplier_id")
          .eq("pop_id", popId)
          .eq("direction", "payable")
  if (partyId) {
    query =
      direction === "receivable"
        ? query.eq("client_id", partyId)
        : query.eq("supplier_id", partyId)
  }
  const { data: receipts } = await query
  const unapplied = new Map<string, number>()
  if (!receipts?.length) return unapplied

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

  for (const row of receipts) {
    const raw = row as Record<string, unknown>
    const party = String(direction === "receivable" ? raw.client_id : raw.supplier_id)
    if (!party) continue
    const leftover = currentAccountOpenAmount(
      Number(raw.amount ?? 0) || 0,
      applied.get(String(raw.id)) ?? 0,
    )
    if (leftover <= 0.009) continue
    unapplied.set(party, roundMoney((unapplied.get(party) ?? 0) + leftover))
  }
  return unapplied
}

export function emptyPartyRow(
  partyId: string,
  partyName: string,
  enrolled = false,
): CurrentAccountPartyRow {
  return {
    partyId,
    partyName,
    enrolled,
    openCount: 0,
    overdueAmount: 0,
    aging: emptyCurrentAccountAgingTotals(),
    balance: 0,
    unappliedCredit: 0,
    creditLimit: null,
    termDays: CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS,
  }
}

type EnrolledPartyRecord = {
  id: string
  name: string
  creditLimit: number | null
  termDays: number
}

export async function loadEnrolledParties(
  supabase: SupabaseClient,
  popId: string,
  direction: CurrentAccountDirection,
): Promise<EnrolledPartyRecord[]> {
  const table = direction === "receivable" ? "clients" : "suppliers"
  const { data } = await supabase
    .from(table)
    .select("id, name, current_account_credit_limit, current_account_term_days")
    .eq("pop_id", popId)
    .eq("current_account_enabled", true)
    .order("name", { ascending: true })
  return (data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? "").trim(),
    creditLimit: normalizeCurrentAccountCreditLimit(row.current_account_credit_limit),
    termDays: normalizeCurrentAccountTermDays(row.current_account_term_days),
  }))
}

function applyEnrollmentTerms(
  party: CurrentAccountPartyRow,
  enrolled: EnrolledPartyRecord,
) {
  party.enrolled = true
  party.creditLimit = enrolled.creditLimit
  party.termDays = enrolled.termDays
  if (!party.partyName.trim() && enrolled.name) {
    party.partyName = enrolled.name
  }
}

export function mergeEnrolledParties(
  parties: CurrentAccountPartyRow[],
  enrolled: EnrolledPartyRecord[],
): CurrentAccountPartyRow[] {
  const byId = new Map(parties.map((row) => [row.partyId, row]))
  for (const row of enrolled) {
    const current = byId.get(row.id)
    if (current) {
      applyEnrollmentTerms(current, row)
      continue
    }
    const next = emptyPartyRow(row.id, row.name || "—", true)
    applyEnrollmentTerms(next, row)
    byId.set(row.id, next)
  }
  return [...byId.values()]
}

export function groupParties(
  documents: DocumentOpenItem[],
  today: string,
  unappliedByParty: Map<string, number>,
): CurrentAccountPartyRow[] {
  const byParty = new Map<string, CurrentAccountPartyRow>()
  for (const doc of documents) {
    const current = byParty.get(doc.partyId) ?? emptyPartyRow(doc.partyId, doc.partyName)
    if (doc.remaining > 0.009) {
      current.openCount += 1
      current.balance = roundMoney(current.balance + doc.remaining)
      const bucket = currentAccountAgingBucket(doc.dueDate, today)
      current.aging = addCurrentAccountAgingAmount(current.aging, bucket, doc.remaining)
      if (bucket !== "current") {
        current.overdueAmount = roundMoney(current.overdueAmount + doc.remaining)
      }
    }
    if (doc.partyName && current.partyName === "Cliente") {
      current.partyName = doc.partyName
    }
    byParty.set(doc.partyId, current)
  }
  for (const [partyId, credit] of unappliedByParty) {
    const current = byParty.get(partyId) ?? emptyPartyRow(partyId, "")
    current.unappliedCredit = credit
    current.balance = roundMoney(current.balance - credit)
    byParty.set(partyId, current)
  }
  return [...byParty.values()].filter(
    (row) => row.openCount > 0 || Math.abs(row.balance) > 0.009,
  )
}

export async function fillMissingPartyNames(
  supabase: SupabaseClient,
  direction: CurrentAccountDirection,
  parties: CurrentAccountPartyRow[],
): Promise<void> {
  const missing = parties.filter((row) => !row.partyName.trim())
  if (missing.length === 0) return
  const table = direction === "receivable" ? "clients" : "suppliers"
  const { data } = await supabase
    .from(table)
    .select("id, name")
    .in(
      "id",
      missing.map((row) => row.partyId),
    )
  const names = new Map(
    (data ?? []).map((row) => [String(row.id), String(row.name ?? "").trim()]),
  )
  const fallback = direction === "receivable" ? "Cliente" : "Proveedor"
  for (const row of missing) {
    row.partyName = names.get(row.partyId) || fallback
  }
}

function creditLimitSortValue(row: CurrentAccountPartyRow): number {
  if (!row.enrolled) return Number.NEGATIVE_INFINITY
  if (row.creditLimit == null) return Number.POSITIVE_INFINITY
  return row.creditLimit
}

function termDaysSortValue(row: CurrentAccountPartyRow): number {
  if (!row.enrolled) return Number.NEGATIVE_INFINITY
  return row.termDays
}

export function sortParties(
  rows: CurrentAccountPartyRow[],
  sort: CurrentAccountTableSortKey | null,
  ascending: boolean,
): CurrentAccountPartyRow[] {
  const key = sort ?? "balance"
  const dir = ascending ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === "party_name") {
      return a.partyName.localeCompare(b.partyName, "es") * dir
    }
    if (key === "credit_limit") {
      const left = creditLimitSortValue(a)
      const right = creditLimitSortValue(b)
      if (left === right) return 0
      return (left < right ? -1 : 1) * dir
    }
    if (key === "term_days") {
      const left = termDaysSortValue(a)
      const right = termDaysSortValue(b)
      if (left === right) return 0
      return (left < right ? -1 : 1) * dir
    }
    if (key === "open_count") return (a.openCount - b.openCount) * dir
    if (key === "overdue") return (a.overdueAmount - b.overdueAmount) * dir
    return (a.balance - b.balance) * dir
  })
}

export async function loadPopTimeZone(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
): Promise<string> {
  const { data } = await supabase
    .from("pops")
    .select("country")
    .eq("id", popId)
    .maybeSingle()
  return timezoneForPopLedger(
    data?.country != null ? String(data.country) : null,
    siteId,
  )
}
