import type { SupabaseClient } from "@supabase/supabase-js"
import type { ClientListData, ClientRow, ListClientsQuery } from "./schema.js"

export const CLIENT_SELECT =
  "id, name, email, phone, tax_id, notes, iva_condition, address_line, default_invoice_type_label, is_active, current_account_enabled, current_account_credit_limit, current_account_term_days"

const CLIENT_LIST_SORT: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  tax_id: "tax_id",
  iva: "iva_condition",
}

const DEFAULT_TERM_DAYS = 30

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function buildSearchOrClause(raw: string): string | null {
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

function appendClientListFilters<
  Q extends {
    eq: (a: string, b: string | boolean) => Q
    neq: (a: string, b: string) => Q
    or: (s: string) => Q
  },
>(q: Q, input: ListClientsQuery): Q {
  let x = q
  if (input.soloActivos) x = x.eq("is_active", true)
  if (input.withEmail) x = x.neq("email", "")
  if (input.withTaxId) x = x.neq("tax_id", "")
  const orClause = buildSearchOrClause(input.search)
  if (orClause) x = x.or(orClause)
  return x
}

function mapClientRow(
  row: Record<string, unknown>,
  stats: { lastSaleAt: string | null; count: number; totalSpentArs: number },
): ClientRow {
  const ivaRaw = row.iva_condition
  const ivaStr =
    typeof ivaRaw === "string" && ivaRaw.trim() !== "" ? ivaRaw.trim() : null
  const invoiceRaw = row.default_invoice_type_label
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    taxId: String(row.tax_id ?? ""),
    notes: String(row.notes ?? ""),
    ivaCondition: ivaStr,
    addressLine: String(row.address_line ?? ""),
    defaultInvoiceTypeLabel:
      invoiceRaw != null && String(invoiceRaw).trim() !== ""
        ? String(invoiceRaw).trim()
        : null,
    isActive: Boolean(row.is_active ?? true),
    currentAccountEnabled: row.current_account_enabled === true,
    currentAccountCreditLimit: normalizeCurrentAccountCreditLimit(
      row.current_account_credit_limit,
    ),
    currentAccountTermDays: normalizeCurrentAccountTermDays(
      row.current_account_term_days,
    ),
    lastSaleAt: stats.lastSaleAt,
    completedSalesCount: stats.count,
    totalSpentArs: stats.totalSpentArs,
  }
}

function aggregateCompletedSales(
  rows: { client_id: string | null; total: unknown; sold_at: string }[],
): Map<string, { lastSaleAt: string | null; count: number; totalSpentArs: number }> {
  const map = new Map<
    string,
    { lastMs: number; count: number; totalSpentArs: number }
  >()
  for (const r of rows) {
    const cid = r.client_id
    if (!cid) continue
    const n =
      typeof r.total === "number"
        ? r.total
        : typeof r.total === "string"
          ? Number(r.total)
          : NaN
    const total = Number.isFinite(n) ? n : 0
    const soldMs = r.sold_at ? Date.parse(r.sold_at) : NaN
    const cur = map.get(cid) ?? { lastMs: -1, count: 0, totalSpentArs: 0 }
    cur.count += 1
    cur.totalSpentArs += total
    if (Number.isFinite(soldMs) && soldMs > cur.lastMs) cur.lastMs = soldMs
    map.set(cid, cur)
  }
  const out = new Map<
    string,
    { lastSaleAt: string | null; count: number; totalSpentArs: number }
  >()
  for (const [cid, v] of map) {
    out.set(cid, {
      lastSaleAt: v.lastMs >= 0 ? new Date(v.lastMs).toISOString() : null,
      count: v.count,
      totalSpentArs: v.totalSpentArs,
    })
  }
  return out
}

export async function listClients(
  supabase: SupabaseClient,
  popId: string,
  input: ListClientsQuery,
  caps: Pick<ClientListData, "canCreate" | "canUpdate" | "canDelete">,
): Promise<
  { success: true; data: ClientListData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  countQuery = appendClientListFilters(countQuery, input)

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const sortColumn = input.sort ? CLIENT_LIST_SORT[input.sort] : "name"
  const ascending = input.sort ? input.ord === "asc" : true

  let dataQuery = supabase
    .from("clients")
    .select(CLIENT_SELECT)
    .eq("pop_id", popId)
  dataQuery = appendClientListFilters(dataQuery, input)
  dataQuery = dataQuery
    .order(sortColumn ?? "name", { ascending })
    .range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  const clientRows = data ?? []
  const clientIds = clientRows.map((r) => String(r.id))
  let agg = new Map<
    string,
    { lastSaleAt: string | null; count: number; totalSpentArs: number }
  >()
  if (clientIds.length > 0) {
    const { data: saleRows, error: salesErr } = await supabase
      .from("sales")
      .select("client_id, total, sold_at")
      .eq("pop_id", popId)
      .eq("status", "completed")
      .not("client_id", "is", null)
      .in("client_id", clientIds)
    if (!salesErr && saleRows?.length) {
      agg = aggregateCompletedSales(
        saleRows as {
          client_id: string | null
          total: unknown
          sold_at: string
        }[],
      )
    }
  }

  return {
    success: true,
    data: {
      clients: clientRows.map((row) => {
        const id = String(row.id)
        return mapClientRow(row as Record<string, unknown>, agg.get(id) ?? {
          lastSaleAt: null,
          count: 0,
          totalSpentArs: 0,
        })
      }),
      totalCount,
      page,
      pageSize: input.pageSize,
      ...caps,
    },
  }
}
