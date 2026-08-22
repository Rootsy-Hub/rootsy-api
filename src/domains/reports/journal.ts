import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "./money.js"
import type {
  JournalEntryLineRow,
  JournalEntrySummaryRow,
  JournalListData,
  JournalTotalsData,
} from "./schema.js"

const JOURNAL_ENTRY_ID_CHUNK = 400

function applyPostedEntryDateFilters<
  T extends {
    gte: (column: string, value: string) => T
    lte: (column: string, value: string) => T
  },
>(query: T, fromDate: string | null, toDate: string | null): T {
  let next = query
  if (fromDate && fromDate.trim()) {
    next = next.gte("entry_date", fromDate.trim())
  }
  if (toDate && toDate.trim()) {
    next = next.lte("entry_date", toDate.trim())
  }
  return next
}

export async function getJournalTotals(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
): Promise<
  { success: true; data: JournalTotalsData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("accounting_entries")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("status", "posted")
  countQuery = applyPostedEntryDateFilters(countQuery, fromDate, toDate)

  let idsQuery = supabase
    .from("accounting_entries")
    .select("id")
    .eq("pop_id", popId)
    .eq("status", "posted")
  idsQuery = applyPostedEntryDateFilters(idsQuery, fromDate, toDate)

  const [countResult, idsResult] = await Promise.all([countQuery, idsQuery])
  if (countResult.error) {
    return {
      success: false,
      error: countResult.error.message || "No se pudieron contar los asientos.",
    }
  }
  if (idsResult.error) {
    return {
      success: false,
      error: idsResult.error.message || "No se pudieron listar los asientos.",
    }
  }

  const ids = (idsResult.data || []).map((entry) => String(entry.id))
  let totalDebit = 0
  let totalCredit = 0
  for (let i = 0; i < ids.length; i += JOURNAL_ENTRY_ID_CHUNK) {
    const chunk = ids.slice(i, i + JOURNAL_ENTRY_ID_CHUNK)
    const { data: lines, error: lErr } = await supabase
      .from("accounting_entry_lines")
      .select("debit_amount, credit_amount")
      .in("entry_id", chunk)
    if (lErr) {
      return {
        success: false,
        error: lErr.message || "No se pudieron calcular los totales del período.",
      }
    }
    for (const line of lines || []) {
      totalDebit += parseMoney(line.debit_amount)
      totalCredit += parseMoney(line.credit_amount)
    }
  }

  return {
    success: true,
    data: {
      totalCount: countResult.count ?? 0,
      periodTotalDebit: roundMoney(totalDebit),
      periodTotalCredit: roundMoney(totalCredit),
    },
  }
}

export async function getJournalEntries(
  supabase: SupabaseClient,
  popId: string,
  fromDate: string | null,
  toDate: string | null,
  page: number,
  pageSize: number,
): Promise<
  { success: true; data: JournalListData } | { success: false; error: string }
> {
  const safePage = Math.max(1, page)
  const safeSize = Math.min(Math.max(pageSize, 1), 100)
  const offset = (safePage - 1) * safeSize

  let countQuery = supabase
    .from("accounting_entries")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("status", "posted")
  countQuery = applyPostedEntryDateFilters(countQuery, fromDate, toDate)
  const { count, error: countErr } = await countQuery
  if (countErr) {
    return {
      success: false,
      error: countErr.message || "No se pudieron cargar los asientos.",
    }
  }

  const totalCount = count ?? 0
  let q = supabase
    .from("accounting_entries")
    .select("id, entry_number, entry_date, description, source_type, status")
    .eq("pop_id", popId)
    .eq("status", "posted")
    .order("entry_date", { ascending: false })
    .order("entry_number", { ascending: false })
  q = applyPostedEntryDateFilters(q, fromDate, toDate)
  q = q.range(offset, offset + safeSize)

  const { data: entries, error: eErr } = await q
  if (eErr) {
    return {
      success: false,
      error: eErr.message || "No se pudieron cargar los asientos.",
    }
  }

  const rawList = entries || []
  const hasMore = rawList.length > safeSize
  const list = rawList.slice(0, safeSize)
  if (list.length === 0) {
    return {
      success: true,
      data: {
        entries: [],
        hasMore: false,
        page: safePage,
        pageSize: safeSize,
        totalCount,
      },
    }
  }

  const ids = list.map((e) => String(e.id))
  const { data: lines, error: lErr } = await supabase
    .from("accounting_entry_lines")
    .select("entry_id, debit_amount, credit_amount")
    .in("entry_id", ids)
  if (lErr) {
    return {
      success: false,
      error: lErr.message || "No se pudieron cargar las líneas.",
    }
  }

  const debitByEntry = new Map<string, number>()
  const creditByEntry = new Map<string, number>()
  for (const ln of lines || []) {
    const eid = String(ln.entry_id)
    debitByEntry.set(eid, (debitByEntry.get(eid) ?? 0) + parseMoney(ln.debit_amount))
    creditByEntry.set(
      eid,
      (creditByEntry.get(eid) ?? 0) + parseMoney(ln.credit_amount),
    )
  }

  const rows: JournalEntrySummaryRow[] = list.map((e) => {
    const id = String(e.id)
    return {
      id,
      entryNumber: Number(e.entry_number ?? 0),
      entryDate: String(e.entry_date ?? ""),
      description: String(e.description ?? ""),
      sourceType: String(e.source_type ?? ""),
      totalDebit: roundMoney(debitByEntry.get(id) ?? 0),
      totalCredit: roundMoney(creditByEntry.get(id) ?? 0),
    }
  })

  return {
    success: true,
    data: {
      entries: rows,
      hasMore,
      page: safePage,
      pageSize: safeSize,
      totalCount,
    },
  }
}

export async function getJournalEntryLines(
  supabase: SupabaseClient,
  popId: string,
  entryId: string,
): Promise<
  { success: true; lines: JournalEntryLineRow[] } | { success: false; error: string }
> {
  const { data: entry, error: entErr } = await supabase
    .from("accounting_entries")
    .select("id")
    .eq("id", entryId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (entErr || !entry) {
    return { success: false, error: "Asiento no encontrado." }
  }
  const { data: lines, error: lErr } = await supabase
    .from("accounting_entry_lines")
    .select(
      `
      id,
      debit_amount,
      credit_amount,
      description,
      line_order,
      accounting_chart_of_accounts ( code, name )
    `,
    )
    .eq("entry_id", entryId)
    .order("line_order", { ascending: true })
  if (lErr) {
    return {
      success: false,
      error: lErr.message || "No se pudieron cargar las líneas.",
    }
  }
  const rows: JournalEntryLineRow[] = (lines || []).map((r) => {
    const acc = r.accounting_chart_of_accounts as unknown as {
      code?: string
      name?: string
    } | null
    return {
      id: String(r.id),
      accountCode: acc?.code ? String(acc.code) : "—",
      accountName: acc?.name ? String(acc.name) : "—",
      debitAmount: roundMoney(parseMoney(r.debit_amount)),
      creditAmount: roundMoney(parseMoney(r.credit_amount)),
      lineDescription: r.description != null ? String(r.description) : null,
    }
  })
  return { success: true, lines: rows }
}
