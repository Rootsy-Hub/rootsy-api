import type { SupabaseClient } from "@supabase/supabase-js"
import { listExpenseCategories } from "../expense-categories/queries.js"
import { parseExpenseCategoryKind, parseMoney, roundMoney } from "./accounts.js"
import { monthBoundsISO } from "./month.js"
import type {
  ExpenseListData,
  ExpenseListRow,
  ExpenseStatus,
  ListExpensesQuery,
} from "./schema.js"

export async function listExpensesForMonth(
  supabase: SupabaseClient,
  popId: string,
  input: ListExpensesQuery,
): Promise<
  { success: true; data: ExpenseListData } | { success: false; error: string }
> {
  const { start, end } = monthBoundsISO(input.year, input.month)
  const cats = await listExpenseCategories(supabase, popId, {
    includeDeleted: true,
  })
  if (!cats.success) return cats

  const { data: exRows, error: exErr } = await supabase
    .from("expenses")
    .select(
      `
        id,
        amount,
        currency,
        expense_date,
        due_date,
        description,
        status,
        voided_at,
        void_reason,
        category_id,
        expense_categories ( id, name, kind, deleted_at )
      `,
    )
    .eq("pop_id", popId)
    .gte("expense_date", start)
    .lte("expense_date", end)
    .order("expense_date", { ascending: false })
  if (exErr) {
    return { success: false, error: exErr.message || "No se pudieron cargar gastos." }
  }

  const list = exRows || []
  const ids = list.map((e) => String(e.id))
  const paidByExpense = new Map<string, number>()
  if (ids.length > 0) {
    const { data: payRows, error: payErr } = await supabase
      .from("expense_payments")
      .select("expense_id, amount")
      .in("expense_id", ids)
    if (payErr) {
      return { success: false, error: payErr.message || "No se pudieron cargar pagos." }
    }
    for (const p of payRows || []) {
      const eid = String(p.expense_id)
      paidByExpense.set(eid, (paidByExpense.get(eid) ?? 0) + parseMoney(p.amount))
    }
  }

  const rows: ExpenseListRow[] = list.map((e) => {
    const cat = e.expense_categories as unknown as {
      id?: string
      name?: string
      kind?: string
      deleted_at?: string | null
    } | null
    const id = String(e.id)
    return {
      id,
      amount: parseMoney(e.amount),
      currency: String(e.currency ?? "ARS"),
      expenseDate: String(e.expense_date ?? ""),
      dueDate: e.due_date != null ? String(e.due_date) : null,
      description: String(e.description ?? ""),
      status: String(e.status ?? "pending") as ExpenseStatus,
      voidedAt: e.voided_at != null ? String(e.voided_at) : null,
      voidReason: e.void_reason != null ? String(e.void_reason) : null,
      categoryId: cat?.id != null ? String(cat.id) : String(e.category_id),
      categoryName: cat?.name ? String(cat.name) : "—",
      categoryKind: parseExpenseCategoryKind(cat?.kind),
      categoryDeletedAt: cat?.deleted_at != null ? String(cat.deleted_at) : null,
      paidTotal: roundMoney(paidByExpense.get(id) ?? 0),
    }
  })

  const accountToCategory = new Map<string, string>()
  for (const row of cats.data) {
    if (row.kind !== "otro" || row.deletedAt || !row.accountingChartAccountId) {
      continue
    }
    accountToCategory.set(row.accountingChartAccountId, row.id)
  }

  const ledgerByCategoryId: Record<string, number> = {}
  const accountIds = [...accountToCategory.keys()]
  if (accountIds.length > 0) {
    const { data: lineRows, error: lineErr } = await supabase
      .from("accounting_entry_lines")
      .select(
        "account_id, debit_amount, credit_amount, accounting_entries!inner ( pop_id, status, entry_date )",
      )
      .in("account_id", accountIds)
      .eq("accounting_entries.pop_id", popId)
      .eq("accounting_entries.status", "posted")
      .gte("accounting_entries.entry_date", start)
      .lte("accounting_entries.entry_date", end)
    if (lineErr) {
      return {
        success: false,
        error: lineErr.message || "No se pudieron leer los movimientos del mes.",
      }
    }
    for (const line of lineRows || []) {
      const categoryId = accountToCategory.get(String(line.account_id))
      if (!categoryId) continue
      ledgerByCategoryId[categoryId] = roundMoney(
        (ledgerByCategoryId[categoryId] ?? 0) +
          parseMoney(line.debit_amount) -
          parseMoney(line.credit_amount),
      )
    }
  }

  const openRows = rows.filter((row) => row.status !== "voided")
  const totalDue = roundMoney(openRows.reduce((sum, row) => sum + row.amount, 0))
  const totalPaid = roundMoney(
    openRows.reduce((sum, row) => sum + row.paidTotal, 0),
  )

  return {
    success: true,
    data: {
      rows,
      ledgerByCategoryId,
      progress: { totalDue, totalPaid },
      categories: cats.data,
    },
  }
}
