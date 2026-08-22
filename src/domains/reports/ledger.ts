import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "./money.js"
import type {
  AccountNature,
  LedgerListData,
  LedgerMovementRow,
  LedgerTotalsData,
} from "./schema.js"

async function loadLedgerMovements(
  supabase: SupabaseClient,
  popId: string,
  accountCode: string,
  fromDate: string | null,
  toDate: string | null,
): Promise<
  | {
      success: true
      accountName: string
      nature: AccountNature
      rows: LedgerMovementRow[]
    }
  | { success: false; error: string }
> {
  const code = accountCode.trim()
  if (!code) {
    return { success: false, error: "Indicá un código de cuenta." }
  }
  const { data: acc, error: aErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id, name, nature")
    .eq("pop_id", popId)
    .eq("code", code)
    .maybeSingle()
  if (aErr || !acc) {
    return { success: false, error: "No hay cuenta con ese código en este punto." }
  }
  const accountId = String(acc.id)
  const nature: AccountNature =
    String(acc.nature ?? "deudora") === "acreedora" ? "acreedora" : "deudora"

  let q = supabase
    .from("accounting_entry_lines")
    .select(
      `
      id,
      debit_amount,
      credit_amount,
      accounting_entries!inner ( id, pop_id, status, entry_date, entry_number, description )
    `,
    )
    .eq("account_id", accountId)
    .eq("accounting_entries.pop_id", popId)
    .eq("accounting_entries.status", "posted")

  if (fromDate && fromDate.trim()) {
    q = q.gte("accounting_entries.entry_date", fromDate.trim())
  }
  if (toDate && toDate.trim()) {
    q = q.lte("accounting_entries.entry_date", toDate.trim())
  }

  const { data: lines, error: lErr } = await q
  if (lErr) {
    return {
      success: false,
      error: lErr.message || "No se pudieron cargar movimientos.",
    }
  }

  type LineRow = {
    id: string
    debit: number
    credit: number
    entryDate: string
    entryNumber: number
    description: string
  }

  const filtered: LineRow[] = (lines || []).map((l) => {
    const entry = l.accounting_entries as unknown as {
      entry_date?: string
      entry_number?: number
      description?: string
    } | null
    return {
      id: String(l.id),
      debit: parseMoney(l.debit_amount),
      credit: parseMoney(l.credit_amount),
      entryDate: String(entry?.entry_date ?? ""),
      entryNumber: Number(entry?.entry_number ?? 0),
      description: String(entry?.description ?? ""),
    }
  })

  filtered.sort((a, b) => {
    const da = a.entryDate.localeCompare(b.entryDate)
    if (da !== 0) return da
    return a.entryNumber - b.entryNumber
  })

  let running = 0
  const rows: LedgerMovementRow[] = filtered.map((l) => {
    if (nature === "deudora") {
      running += l.debit - l.credit
    } else {
      running += l.credit - l.debit
    }
    return {
      id: l.id,
      entryDate: l.entryDate,
      entryNumber: l.entryNumber,
      entryDescription: l.description,
      debitAmount: roundMoney(l.debit),
      creditAmount: roundMoney(l.credit),
      runningBalance: roundMoney(running),
    }
  })

  return {
    success: true,
    accountName: String(acc.name ?? ""),
    nature,
    rows,
  }
}

export async function getLedgerTotals(
  supabase: SupabaseClient,
  popId: string,
  accountCode: string,
  fromDate: string | null,
  toDate: string | null,
): Promise<
  { success: true; data: LedgerTotalsData } | { success: false; error: string }
> {
  const loaded = await loadLedgerMovements(
    supabase,
    popId,
    accountCode,
    fromDate,
    toDate,
  )
  if (!loaded.success) return loaded
  const totalDebit = roundMoney(
    loaded.rows.reduce((a, r) => a + r.debitAmount, 0),
  )
  const totalCredit = roundMoney(
    loaded.rows.reduce((a, r) => a + r.creditAmount, 0),
  )
  const closingBalance =
    loaded.rows.length > 0
      ? loaded.rows[loaded.rows.length - 1]!.runningBalance
      : 0
  return {
    success: true,
    data: {
      accountName: loaded.accountName,
      nature: loaded.nature,
      totalCount: loaded.rows.length,
      totalDebit,
      totalCredit,
      closingBalance,
    },
  }
}

export async function getLedgerPage(
  supabase: SupabaseClient,
  popId: string,
  accountCode: string,
  fromDate: string | null,
  toDate: string | null,
  page: number,
  pageSize: number,
): Promise<
  { success: true; data: LedgerListData } | { success: false; error: string }
> {
  const loaded = await loadLedgerMovements(
    supabase,
    popId,
    accountCode,
    fromDate,
    toDate,
  )
  if (!loaded.success) return loaded
  const safePage = Math.max(1, page)
  const safeSize = Math.min(Math.max(pageSize, 1), 100)
  const offset = (safePage - 1) * safeSize
  const slice = loaded.rows.slice(offset, offset + safeSize)
  return {
    success: true,
    data: {
      accountName: loaded.accountName,
      nature: loaded.nature,
      rows: slice,
      hasMore: offset + slice.length < loaded.rows.length,
      page: safePage,
      pageSize: safeSize,
      totalCount: loaded.rows.length,
    },
  }
}
