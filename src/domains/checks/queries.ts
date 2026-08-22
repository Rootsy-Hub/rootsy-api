import type { SupabaseClient } from "@supabase/supabase-js"
import { escapeIlikeToken, mapCheckTableRow } from "./parse.js"
import type {
  CheckDepositAccount,
  CheckDirection,
  CheckListData,
  CheckPartyItem,
  ListChecksQuery,
} from "./schema.js"

const CHECK_SELECT = `
  id,
  direction,
  check_number,
  bank_name,
  amount,
  issue_date,
  due_date,
  status,
  client_id,
  supplier_id,
  drawer_name,
  payee_name,
  source_kind,
  clients!client_id ( name ),
  suppliers!supplier_id ( name )
`

const CHECK_LIST_SORT: Record<string, string> = {
  check_number: "check_number",
  direction: "direction",
  bank_name: "bank_name",
  amount: "amount",
  issue_date: "issue_date",
  due_date: "due_date",
  status: "status",
}

const PARTY_SEARCH_LIMIT = 8

function appendCheckListFilters<
  Q extends {
    eq: (col: string, val: string) => Q
    or: (clause: string) => Q
  },
>(q: Q, input: ListChecksQuery): Q {
  let x = q
  if (input.direction) x = x.eq("direction", input.direction)
  if (input.status) x = x.eq("status", input.status)
  if (input.search) {
    const pattern = `%${escapeIlikeToken(input.search)}%`
    x = x.or(
      [
        `check_number.ilike.${pattern}`,
        `bank_name.ilike.${pattern}`,
        `drawer_name.ilike.${pattern}`,
        `payee_name.ilike.${pattern}`,
      ].join(","),
    )
  }
  return x
}

export async function listChecks(
  supabase: SupabaseClient,
  popId: string,
  input: ListChecksQuery,
): Promise<
  { success: true; data: CheckListData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("checks")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  countQuery = appendCheckListFilters(countQuery, input)

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const sortColumn = input.sort
    ? CHECK_LIST_SORT[input.sort]
    : "due_date"
  const ascending = input.sort ? input.ord === "asc" : false

  let dataQuery = supabase.from("checks").select(CHECK_SELECT).eq("pop_id", popId)
  dataQuery = appendCheckListFilters(dataQuery, input)
  dataQuery = dataQuery
    .order(sortColumn ?? "due_date", { ascending })
    .range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      checks: (data ?? []).map((row) =>
        mapCheckTableRow(row as Record<string, unknown>),
      ),
      totalCount,
      page,
      pageSize: input.pageSize,
    },
  }
}

export async function listCheckDepositAccounts(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: { accounts: CheckDepositAccount[] } }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("treasury_accounts")
    .select("id, name")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .in("kind", ["bank", "wallet"])
    .order("sort_order", { ascending: true })

  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      accounts: (data ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
      })),
    },
  }
}

export async function searchCheckParties(
  supabase: SupabaseClient,
  popId: string,
  direction: CheckDirection,
  query: string,
): Promise<
  | { success: true; data: { parties: CheckPartyItem[] } }
  | { success: false; error: string }
> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { success: true, data: { parties: [] } }
  }

  const pattern = `%${escapeIlikeToken(trimmed)}%`
  const table = direction === "issued" ? "suppliers" : "clients"
  const { data, error } = await supabase
    .from(table)
    .select("id, name, tax_id")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .or(`name.ilike.${pattern},tax_id.ilike.${pattern}`)
    .order("name", { ascending: true })
    .limit(PARTY_SEARCH_LIMIT)

  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      parties: (data ?? []).map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
        taxId:
          row.tax_id != null && String(row.tax_id).trim() !== ""
            ? String(row.tax_id).trim()
            : null,
      })),
    },
  }
}
