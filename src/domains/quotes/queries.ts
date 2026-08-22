import type { SupabaseClient } from "@supabase/supabase-js"
import { mapQuoteDetail, mapQuoteRow } from "./parse.js"
import type { ListQuotesQuery, QuoteListData, SaleQuoteDetail } from "./schema.js"
import {
  localDateExclusiveEndTimestamp,
  localDateStartTimestamp,
  timezoneForPopLedger,
} from "./timezone.js"

const QUOTE_LIST_SELECT =
  "id, quote_number, customer_name, customer_tax_id, subtotal, discount_total, total, status, created_at, metadata"

const QUOTE_DETAIL_SELECT = `${QUOTE_LIST_SELECT}, client_id, checkout_snapshot`

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

async function loadPopTimeZone(
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

function appendQuotesFilters<
  Q extends {
    gte: (col: string, val: string) => Q
    lt: (col: string, val: string) => Q
    ilike: (col: string, val: string) => Q
  },
>(q: Q, input: ListQuotesQuery, timeZone: string): Q {
  let x = q
  if (input.dateFrom) {
    x = x.gte("created_at", localDateStartTimestamp(timeZone, input.dateFrom))
  }
  if (input.dateTo) {
    x = x.lt("created_at", localDateExclusiveEndTimestamp(timeZone, input.dateTo))
  }
  if (input.search) {
    x = x.ilike("customer_name", `%${escapeIlikeToken(input.search)}%`)
  }
  return x
}

export async function listQuotes(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  input: ListQuotesQuery,
): Promise<
  { success: true; data: QuoteListData } | { success: false; error: string }
> {
  const timeZone = await loadPopTimeZone(supabase, popId, siteId)

  let countQuery = supabase
    .from("sale_quotes")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .neq("status", "cancelled")
  countQuery = appendQuotesFilters(countQuery, input, timeZone)

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize) || 1)
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1

  let dataQuery = supabase
    .from("sale_quotes")
    .select(QUOTE_LIST_SELECT)
    .eq("pop_id", popId)
    .neq("status", "cancelled")
  dataQuery = appendQuotesFilters(dataQuery, input, timeZone)
  dataQuery = dataQuery.order("created_at", { ascending: false }).range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      rows: (data ?? []).map((row) =>
        mapQuoteRow(row as Record<string, unknown>),
      ),
      totalCount,
      page,
      pageSize: input.pageSize,
    },
  }
}

export async function getQuote(
  supabase: SupabaseClient,
  popId: string,
  quoteId: string,
): Promise<
  | { success: true; data: { quote: SaleQuoteDetail } }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("sale_quotes")
    .select(QUOTE_DETAIL_SELECT)
    .eq("pop_id", popId)
    .eq("id", quoteId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Presupuesto no encontrado.", status: 404 }
  }

  const quote = mapQuoteDetail(data as Record<string, unknown>)
  if (!quote) {
    return { success: false, error: "Presupuesto inválido.", status: 404 }
  }

  return { success: true, data: { quote } }
}
