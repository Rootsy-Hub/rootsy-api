import type { SupabaseClient } from "@supabase/supabase-js"
import { mapPurchaseOrderDetail, mapPurchaseOrderRow } from "./parse.js"
import type {
  ListPurchaseOrdersQuery,
  PurchaseOrderDetail,
  PurchaseOrderListData,
} from "./schema.js"
import {
  localDateExclusiveEndTimestamp,
  localDateStartTimestamp,
  timezoneForPopLedger,
} from "./timezone.js"

const ORDER_LIST_SELECT =
  "id, order_number, supplier_name, supplier_tax_id, subtotal, discount_total, total, status, created_at, metadata"

const ORDER_DETAIL_SELECT = `${ORDER_LIST_SELECT}, supplier_id, checkout_snapshot`

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

function appendOrdersFilters<
  Q extends {
    gte: (col: string, val: string) => Q
    lt: (col: string, val: string) => Q
    ilike: (col: string, val: string) => Q
  },
>(q: Q, input: ListPurchaseOrdersQuery, timeZone: string): Q {
  let x = q
  if (input.dateFrom) {
    x = x.gte("created_at", localDateStartTimestamp(timeZone, input.dateFrom))
  }
  if (input.dateTo) {
    x = x.lt("created_at", localDateExclusiveEndTimestamp(timeZone, input.dateTo))
  }
  if (input.search) {
    x = x.ilike("supplier_name", `%${escapeIlikeToken(input.search)}%`)
  }
  return x
}

export async function listPurchaseOrders(
  supabase: SupabaseClient,
  popId: string,
  siteId: string,
  input: ListPurchaseOrdersQuery,
): Promise<
  | { success: true; data: PurchaseOrderListData }
  | { success: false; error: string }
> {
  const timeZone = await loadPopTimeZone(supabase, popId, siteId)

  let countQuery = supabase
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .neq("status", "cancelled")
  countQuery = appendOrdersFilters(countQuery, input, timeZone)

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize) || 1)
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1

  let dataQuery = supabase
    .from("purchase_orders")
    .select(ORDER_LIST_SELECT)
    .eq("pop_id", popId)
    .neq("status", "cancelled")
  dataQuery = appendOrdersFilters(dataQuery, input, timeZone)
  dataQuery = dataQuery.order("created_at", { ascending: false }).range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: {
      rows: (data ?? []).map((row) =>
        mapPurchaseOrderRow(row as Record<string, unknown>),
      ),
      totalCount,
      page,
      pageSize: input.pageSize,
    },
  }
}

export async function getPurchaseOrder(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
): Promise<
  | { success: true; data: { order: PurchaseOrderDetail } }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("purchase_orders")
    .select(ORDER_DETAIL_SELECT)
    .eq("pop_id", popId)
    .eq("id", orderId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Orden de compra no encontrada.", status: 404 }
  }

  const order = mapPurchaseOrderDetail(data as Record<string, unknown>)
  if (!order) {
    return { success: false, error: "Orden de compra inválida.", status: 404 }
  }

  return { success: true, data: { order } }
}
