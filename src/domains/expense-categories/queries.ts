import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import { auditedUpdate } from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import {
  EXPENSE_FAMILY_PREFIX,
  isExpenseDefaultChartCode,
  isExpenseSystemViewOnlyCode,
  nextExpenseChartCode,
  sortOrderFromChartCode,
  type ExpenseFamily,
} from "./chart.js"
import type { ExpenseCategoryRow } from "./schema.js"

const SELECT =
  "id, pop_id, name, kind, sort_order, deleted_at, created_at, accounting_chart_account_id, accounting_chart_of_accounts ( code, metadata )"

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
    | { code?: string | null; metadata?: { user_created?: boolean } }
    | { code?: string | null; metadata?: { user_created?: boolean } }[]
    | null
}

function chartFromRow(row: ExpenseCategoryDbRow): {
  code: string | null
  userCreated: boolean
} {
  const rel = row.accounting_chart_of_accounts
  const chart = Array.isArray(rel) ? rel[0] : rel
  return {
    code: chart?.code != null ? String(chart.code) : null,
    userCreated: chart?.metadata?.user_created === true,
  }
}

function mapRow(row: ExpenseCategoryDbRow): ExpenseCategoryRow {
  const { code, userCreated } = chartFromRow(row)
  const readOnly = code ? isExpenseSystemViewOnlyCode(code) : false
  const seeded = code ? isExpenseDefaultChartCode(code) : false
  return {
    id: row.id,
    popId: row.pop_id,
    name: row.name,
    kind: row.kind as ExpenseCategoryRow["kind"],
    sortOrder: row.sort_order ?? 0,
    deletedAt: row.deleted_at,
    accountingChartAccountId: row.accounting_chart_account_id,
    accountCode: code,
    createdAt: row.created_at,
    readOnly,
    canDelete: userCreated && !readOnly && !seeded,
  }
}

export async function seedPopExpenseCategories(
  supabase: SupabaseClient,
  popId: string,
): Promise<void> {
  await supabase.rpc("ensure_pop_expense_categories_from_chart", {
    p_pop_id: popId,
  })
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

  await seedPopExpenseCategories(supabase, popId)

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
  audit: MutationAuditCtx,
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
  const chartId = randomUUID()
  const categoryId = randomUUID()
  const now = new Date().toISOString()
  const sortOrder = sortOrderFromChartCode(prefix, code)
  const ops: AuditOp[] = [
    {
      op: "insert",
      table: "accounting_chart_of_accounts",
      row: {
        id: chartId,
        pop_id: popId,
        code,
        name: input.name,
        account_type: "gastos",
        nature: "deudora",
        level: 4,
        is_movement_account: true,
        parent_id: String(parent.id),
        metadata: { user_created: true, expense_category: true },
      },
    },
    {
      op: "insert",
      table: "expense_categories",
      row: {
        id: categoryId,
        pop_id: popId,
        name: input.name,
        kind: input.kind,
        sort_order: sortOrder,
        accounting_chart_account_id: chartId,
      },
    },
  ]
  const nextRow: ExpenseCategoryDbRow = {
    id: categoryId,
    pop_id: popId,
    name: input.name,
    kind: input.kind,
    sort_order: sortOrder,
    deleted_at: null,
    created_at: now,
    accounting_chart_account_id: chartId,
    accounting_chart_of_accounts: {
      code,
      metadata: { user_created: true },
    },
  }
  const applied = await applyWithAudit(supabase, {
    kind: "expense-categories.create",
    ctx: audit,
    popId,
    resourceId: categoryId,
    previous: null,
    next: nextRow,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error || "No se pudo crear." }
  }

  const fetched = await getExpenseCategory(supabase, popId, categoryId)
  if (fetched.success) return fetched
  return { success: true, data: mapRow(nextRow) }
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
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: ExpenseCategoryRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const existing = await getExpenseCategory(supabase, popId, categoryId)
  if (!existing.success) return existing
  if (existing.data.deletedAt) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }

  const patch: Record<string, unknown> = {}
  if (input.name != null) patch.name = input.name
  if (input.kind != null) patch.kind = input.kind
  if (input.sortOrder != null) patch.sort_order = input.sortOrder

  const ops: AuditOp[] = [
    { op: "update", table: "expense_categories", id: categoryId, row: patch },
  ]
  if (input.name != null && existing.data.accountingChartAccountId) {
    ops.push({
      op: "update",
      table: "accounting_chart_of_accounts",
      id: existing.data.accountingChartAccountId,
      row: { name: input.name },
    })
  }

  const applied = await applyWithAudit(supabase, {
    kind: "expense-categories.patch",
    ctx: audit,
    popId,
    resourceId: categoryId,
    previous: existing.data,
    next: { ...existing.data, ...patch },
    ops,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status === 404 ? 404 : 500,
    }
  }

  const fetched = await getExpenseCategory(supabase, popId, categoryId)
  if (fetched.success) return fetched
  return {
    success: true,
    data: {
      ...existing.data,
      name: input.name ?? existing.data.name,
      kind: input.kind ?? existing.data.kind,
      sortOrder: input.sortOrder ?? existing.data.sortOrder,
    },
  }
}

export async function deleteExpenseCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
  audit: MutationAuditCtx,
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
  if (!existing.data.canDelete) {
    return {
      success: false,
      status: 409,
      error: existing.data.readOnly
        ? "Esa cuenta la usa otro módulo."
        : "Las cuentas del plan no se eliminan desde acá.",
    }
  }
  if ((count ?? 0) > 0) {
    const deletedAt = new Date().toISOString()
    const applied = await auditedUpdate(supabase, {
      kind: "expense-categories.delete",
      table: "expense_categories",
      id: categoryId,
      row: { deleted_at: deletedAt },
      ctx: audit,
      popId,
      previous: existing.data,
      next: null,
    })
    if (!applied.success) {
      return {
        success: false,
        error: applied.error,
        status: applied.status === 404 ? 404 : 500,
      }
    }
    return { success: true }
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

  const ops: AuditOp[] = [
    { op: "delete", table: "expense_categories", id: categoryId },
  ]
  if (chartId) {
    ops.push({ op: "delete", table: "accounting_chart_of_accounts", id: chartId })
  }
  const applied = await applyWithAudit(supabase, {
    kind: "expense-categories.delete",
    ctx: audit,
    popId,
    resourceId: categoryId,
    previous: existing.data,
    next: null,
    ops,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status === 404 ? 404 : 500,
    }
  }
  return { success: true }
}
