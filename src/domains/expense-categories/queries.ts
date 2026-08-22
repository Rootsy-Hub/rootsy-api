import type { SupabaseClient } from "@supabase/supabase-js"
import {
  EXPENSE_FAMILY_PREFIX,
  nextExpenseChartCode,
  sortOrderFromChartCode,
  type ExpenseFamily,
} from "./chart.js"
import type { ExpenseCategoryRow } from "./schema.js"

const SELECT =
  "id, pop_id, name, kind, sort_order, deleted_at, created_at, accounting_chart_account_id, accounting_chart_of_accounts ( code )"

type ExpenseCategoryDbRow = {
  id: string
  pop_id: string
  name: string
  kind: string
  sort_order: number
  deleted_at: string | null
  created_at: string
  accounting_chart_account_id: string | null
  accounting_chart_of_accounts?:
    | { code?: string | null }
    | { code?: string | null }[]
    | null
}

function chartCodeFromRow(row: ExpenseCategoryDbRow): string | null {
  const rel = row.accounting_chart_of_accounts
  const chart = Array.isArray(rel) ? rel[0] : rel
  return chart?.code != null ? String(chart.code) : null
}

function mapRow(row: ExpenseCategoryDbRow): ExpenseCategoryRow {
  return {
    id: row.id,
    popId: row.pop_id,
    name: row.name,
    kind: row.kind as ExpenseCategoryRow["kind"],
    sortOrder: row.sort_order ?? 0,
    deletedAt: row.deleted_at,
    accountingChartAccountId: row.accounting_chart_account_id,
    accountCode: chartCodeFromRow(row),
    createdAt: row.created_at,
  }
}

export async function listExpenseCategories(
  supabase: SupabaseClient,
  popId: string,
  filters: {
    kind?: ExpenseCategoryRow["kind"]
    includeDeleted?: boolean
  },
): Promise<
  { success: true; data: ExpenseCategoryRow[] } | { success: false; error: string }
> {
  let q = supabase
    .from("expense_categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .order("sort_order")
    .order("name")

  if (!filters.includeDeleted) q = q.is("deleted_at", null)
  if (filters.kind) q = q.eq("kind", filters.kind)

  const { data, error } = await q
  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: (data ?? []).map((row) => mapRow(row as ExpenseCategoryDbRow)),
  }
}

export async function getExpenseCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<
  | { success: true; data: ExpenseCategoryRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("expense_categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("id", categoryId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }
  return { success: true, data: mapRow(data as ExpenseCategoryDbRow) }
}

export async function createExpenseCategory(
  supabase: SupabaseClient,
  popId: string,
  input: {
    name: string
    kind: "fijo" | "variable"
    family: ExpenseFamily
  },
): Promise<
  | { success: true; data: ExpenseCategoryRow }
  | { success: false; error: string; status?: 400 }
> {
  const prefix = EXPENSE_FAMILY_PREFIX[input.family]

  const { data: existingCodes, error: codesErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select("code")
    .eq("pop_id", popId)
    .like("code", `${prefix}.%`)
  if (codesErr) {
    return {
      success: false,
      error: codesErr.message || "No se pudo leer el plan de cuentas.",
    }
  }

  const { data: parent } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id")
    .eq("pop_id", popId)
    .eq("code", prefix)
    .maybeSingle()
  if (!parent?.id) {
    return {
      success: false,
      status: 400,
      error: `Falta la cuenta padre ${prefix} en el plan.`,
    }
  }

  const code = nextExpenseChartCode(
    prefix,
    (existingCodes ?? []).map((row) => String(row.code ?? "")),
  )

  const { data: chart, error: chartErr } = await supabase
    .from("accounting_chart_of_accounts")
    .insert({
      pop_id: popId,
      code,
      name: input.name,
      account_type: "gastos",
      nature: "deudora",
      level: 4,
      is_movement_account: true,
      parent_id: String(parent.id),
      metadata: { user_created: true, expense_category: true },
    })
    .select("id")
    .single()

  if (chartErr || !chart?.id) {
    return {
      success: false,
      error: chartErr?.message || "No se pudo crear la cuenta contable.",
    }
  }

  const { data, error } = await supabase
    .from("expense_categories")
    .insert({
      pop_id: popId,
      name: input.name,
      kind: input.kind,
      sort_order: sortOrderFromChartCode(prefix, code),
      accounting_chart_account_id: String(chart.id),
    })
    .select(SELECT)
    .single()

  if (error || !data) {
    await supabase
      .from("accounting_chart_of_accounts")
      .delete()
      .eq("id", String(chart.id))
      .eq("pop_id", popId)
    return { success: false, error: error?.message || "No se pudo crear." }
  }

  return { success: true, data: mapRow(data as ExpenseCategoryDbRow) }
}

export async function updateExpenseCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
  input: {
    name?: string
    kind?: "fijo" | "variable"
    sortOrder?: number
  },
): Promise<
  | { success: true; data: ExpenseCategoryRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const patch: Record<string, unknown> = {}
  if (input.name != null) patch.name = input.name
  if (input.kind != null) patch.kind = input.kind
  if (input.sortOrder != null) patch.sort_order = input.sortOrder

  const { data, error } = await supabase
    .from("expense_categories")
    .update(patch)
    .eq("id", categoryId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .select(SELECT)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }

  const mapped = mapRow(data as ExpenseCategoryDbRow)
  if (input.name != null && mapped.accountingChartAccountId) {
    await supabase
      .from("accounting_chart_of_accounts")
      .update({ name: input.name })
      .eq("id", mapped.accountingChartAccountId)
      .eq("pop_id", popId)
  }

  return { success: true, data: mapped }
}

export async function deleteExpenseCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<
  { success: true } | { success: false; error: string; status: 404 | 409 | 500 }
> {
  const existing = await getExpenseCategory(supabase, popId, categoryId)
  if (!existing.success) return existing
  if (existing.data.deletedAt) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }

  const { count, error: countError } = await supabase
    .from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("category_id", categoryId)

  if (countError) {
    return { success: false, error: countError.message, status: 500 }
  }
  if ((count ?? 0) > 0) {
    return {
      success: false,
      status: 409,
      error: `No se puede eliminar "${existing.data.name}": tiene ${count} gasto(s).`,
    }
  }

  const chartId = existing.data.accountingChartAccountId
  if (chartId) {
    const { count: lineCount, error: lineErr } = await supabase
      .from("accounting_entry_lines")
      .select("id", { count: "exact", head: true })
      .eq("account_id", chartId)
    if (lineErr) {
      return { success: false, error: lineErr.message, status: 500 }
    }
    if ((lineCount ?? 0) > 0) {
      return {
        success: false,
        status: 409,
        error: `No se puede eliminar "${existing.data.name}": la cuenta tiene asientos.`,
      }
    }
  }

  const { error } = await supabase
    .from("expense_categories")
    .delete()
    .eq("id", categoryId)
    .eq("pop_id", popId)

  if (error) return { success: false, error: error.message, status: 500 }

  if (chartId) {
    await supabase
      .from("accounting_chart_of_accounts")
      .delete()
      .eq("id", chartId)
      .eq("pop_id", popId)
  }

  return { success: true }
}
