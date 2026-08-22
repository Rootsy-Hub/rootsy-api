import type { SupabaseClient } from "@supabase/supabase-js"
import {
  SUPPLIER_SEARCH_LIMIT,
  type ListSuppliersTableQuery,
  type SupplierListData,
  type SupplierOption,
  type SupplierRow,
} from "./schema.js"

type SupplierDbRow = {
  id: string
  name: string | null
}

function mapRow(row: SupplierDbRow): SupplierOption {
  return {
    id: String(row.id),
    name: String(row.name ?? "").trim(),
  }
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function buildSearchOrClause(raw: string): string | null {
  const t = raw.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  return `name.ilike.${pattern},tax_id.ilike.${pattern}`
}

export async function listSupplierOptions(
  supabase: SupabaseClient,
  popId: string,
  filters: { q?: string } = {},
): Promise<
  { success: true; data: SupplierOption[] } | { success: false; error: string }
> {
  const q = filters.q?.trim() ?? ""
  const orClause = q ? buildSearchOrClause(q) : null
  if (q && !orClause) {
    return { success: true, data: [] }
  }

  let query = supabase
    .from("suppliers")
    .select("id, name")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("name", { ascending: true })

  if (orClause) {
    query = query.or(orClause).limit(SUPPLIER_SEARCH_LIMIT)
  }

  const { data, error } = await query
  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: (data ?? []).map((row) => mapRow(row as SupplierDbRow)),
  }
}

export const SUPPLIER_TABLE_SELECT =
  "id, name, email, phone, tax_id, notes, iva_condition, address_line, is_active, current_account_enabled, current_account_credit_limit, current_account_term_days"

const SUPPLIER_LIST_SORT: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  tax_id: "tax_id",
  iva: "iva_condition",
}

const DEFAULT_TERM_DAYS = 30

export function normalizeCurrentAccountTermDays(raw: unknown): number {
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TERM_DAYS
  return Math.min(365, n)
}

export function normalizeCurrentAccountCreditLimit(raw: unknown): number | null {
  if (raw == null || raw === "") return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0.009) return null
  return Math.round(n * 100) / 100
}

function buildTableSearchOrClause(raw: string): string | null {
  const t = raw.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  const cols = [
    "name",
    "email",
    "phone",
    "tax_id",
    "notes",
    "address_line",
    "iva_condition",
  ] as const
  return cols.map((c) => `${c}.ilike.${pattern}`).join(",")
}

function appendSupplierListFilters<
  Q extends {
    eq: (a: string, b: string | boolean) => Q
    neq: (a: string, b: string) => Q
    or: (s: string) => Q
  },
>(q: Q, input: ListSuppliersTableQuery): Q {
  let x = q
  if (input.soloActivos) x = x.eq("is_active", true)
  if (input.withEmail) x = x.neq("email", "")
  if (input.withTaxId) x = x.neq("tax_id", "")
  const orClause = buildTableSearchOrClause(input.search)
  if (orClause) x = x.or(orClause)
  return x
}

function mapSupplierRow(row: Record<string, unknown>): SupplierRow {
  const ivaRaw = row.iva_condition
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    taxId: String(row.tax_id ?? ""),
    notes: String(row.notes ?? ""),
    ivaCondition:
      typeof ivaRaw === "string" && ivaRaw.trim() !== "" ? ivaRaw.trim() : null,
    addressLine: String(row.address_line ?? ""),
    isActive: row.is_active !== false,
    currentAccountEnabled: row.current_account_enabled === true,
    currentAccountCreditLimit: normalizeCurrentAccountCreditLimit(
      row.current_account_credit_limit,
    ),
    currentAccountTermDays: normalizeCurrentAccountTermDays(
      row.current_account_term_days,
    ),
  }
}

export async function listSuppliersTable(
  supabase: SupabaseClient,
  popId: string,
  input: ListSuppliersTableQuery,
  caps: Pick<SupplierListData, "canCreate" | "canUpdate" | "canDelete">,
): Promise<
  { success: true; data: SupplierListData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("suppliers")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  countQuery = appendSupplierListFilters(countQuery, input)

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const sortColumn = input.sort ? SUPPLIER_LIST_SORT[input.sort] : "name"
  const ascending = input.sort ? input.ord === "asc" : true

  let dataQuery = supabase
    .from("suppliers")
    .select(SUPPLIER_TABLE_SELECT)
    .eq("pop_id", popId)
  dataQuery = appendSupplierListFilters(dataQuery, input)
  dataQuery = dataQuery
    .order(sortColumn ?? "name", { ascending })
    .range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      suppliers: (data ?? []).map((row) =>
        mapSupplierRow(row as Record<string, unknown>),
      ),
      totalCount,
      page,
      pageSize: input.pageSize,
      ...caps,
    },
  }
}
