import type { SupabaseClient } from "@supabase/supabase-js"
import { loadUserDisplayNames } from "../operations/loaders.js"
import {
  expandCalendarBoundsForOperationalFetch,
  filterSalesByOperationalPeriod,
  isOperationalDayInRange,
  loadPopOperationalContext,
  operationalDayKey,
} from "../operations/operationalDay.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { saleChannelLabel } from "./compare.js"

const PAGE = 1000

export type SlimLine = {
  articleId: string | null
  recipeId: string | null
  promotionId: string | null
  lineKind: "article" | "recipe" | "promotion" | null
  nameSnapshot: string
  quantity: number
  lineTotal: number
  unitCost: number
}

export type SlimSale = {
  id: string
  soldAt: string
  total: number
  saleChannel: string
  createdBy: string | null
  soldByName: string | null
  customerName: string | null
  clientId: string | null
  lineItems: SlimLine[]
}

export type SlimPurchase = {
  id: string
  occurredAt: string
  total: number
  supplierId: string | null
  supplierName: string | null
  createdBy: string | null
  purchasedByName: string | null
  lineItems: SlimLine[]
}

function parseLines(raw: unknown): SlimLine[] {
  if (!Array.isArray(raw)) return []
  const out: SlimLine[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") continue
    const o = row as Record<string, unknown>
    const lineKindRaw = o.line_kind
    const lineKind =
      lineKindRaw === "article" ||
      lineKindRaw === "recipe" ||
      lineKindRaw === "promotion"
        ? lineKindRaw
        : null
    out.push({
      articleId: o.article_id != null ? String(o.article_id) : null,
      recipeId: o.recipe_id != null ? String(o.recipe_id) : null,
      promotionId: o.promotion_id != null ? String(o.promotion_id) : null,
      lineKind,
      nameSnapshot: String(o.name_snapshot ?? "—"),
      quantity: parseMoney(o.quantity),
      lineTotal: parseMoney(o.line_total),
      unitCost: parseMoney(o.unit_cost ?? o.unit_price),
    })
  }
  return out
}

async function pageRows<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  while (from < 20_000) {
    const page = await fetchPage(from, from + PAGE - 1)
    rows.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }
  return rows
}

export async function loadSlimSales(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  from: string | null,
  to: string | null,
  channel: string | null,
  includeLines: boolean,
  includeUserNames = false,
): Promise<{
  sales: SlimSale[]
  timeZone: string
  operationalDayCloseTime: string
}> {
  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const bounds = expandCalendarBoundsForOperationalFetch(from, to)
  const raw = includeLines
    ? await pageRows(async (start, end) => {
        let q = supabase
          .from("sales")
          .select(
            "id, sold_at, total, status, sale_channel, created_by, customer_name, client_id, line_items",
          )
          .eq("pop_id", popId)
          .eq("status", "completed")
          .order("sold_at", { ascending: true })
          .range(start, end)
        if (bounds.from) q = q.gte("sold_at", `${bounds.from}T00:00:00`)
        if (bounds.to) q = q.lte("sold_at", `${bounds.to}T23:59:59.999`)
        const { data } = await q
        return data || []
      })
    : await pageRows(async (start, end) => {
        let q = supabase
          .from("sales")
          .select(
            "id, sold_at, total, status, sale_channel, created_by, customer_name, client_id",
          )
          .eq("pop_id", popId)
          .eq("status", "completed")
          .order("sold_at", { ascending: true })
          .range(start, end)
        if (bounds.from) q = q.gte("sold_at", `${bounds.from}T00:00:00`)
        if (bounds.to) q = q.lte("sold_at", `${bounds.to}T23:59:59.999`)
        const { data } = await q
        return data || []
      })

  const userNames = includeUserNames
    ? await loadUserDisplayNames(
        supabase,
        raw.map((row) => (row.created_by != null ? String(row.created_by) : "")),
      )
    : new Map<string, string>()

  const mapped: SlimSale[] = raw.map((row) => ({
    id: String(row.id),
    soldAt: String(row.sold_at ?? ""),
    total: parseMoney(row.total),
    saleChannel: String(row.sale_channel ?? "pos"),
    createdBy: row.created_by != null ? String(row.created_by) : null,
    soldByName: row.created_by
      ? (userNames.get(String(row.created_by)) ?? "Usuario")
      : null,
    customerName: row.customer_name != null ? String(row.customer_name) : null,
    clientId: row.client_id != null ? String(row.client_id) : null,
    lineItems:
      includeLines && "line_items" in row ? parseLines(row.line_items) : [],
  }))

  const byPeriod = filterSalesByOperationalPeriod(
    mapped,
    from,
    to,
    operational.timeZone,
    operational.operationalDayCloseTime,
  )

  const sales = channel
    ? byPeriod.filter((sale) => saleChannelLabel(sale.saleChannel) === channel)
    : byPeriod

  return {
    sales,
    timeZone: operational.timeZone,
    operationalDayCloseTime: operational.operationalDayCloseTime,
  }
}

function purchaseAnchor(row: {
  received_at?: unknown
  document_date?: unknown
  created_at?: unknown
}): string {
  const received = String(row.received_at ?? "").trim()
  if (received) return received
  const documentDate = String(row.document_date ?? "").trim()
  if (documentDate) {
    return documentDate.length === 10 ? `${documentDate}T12:00:00` : documentDate
  }
  return String(row.created_at ?? "")
}

export async function loadSlimPurchases(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  from: string | null,
  to: string | null,
  supplier: string | null,
  includeLines: boolean,
  includeUserNames = false,
): Promise<{
  purchases: SlimPurchase[]
  timeZone: string
  operationalDayCloseTime: string
}> {
  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const bounds = expandCalendarBoundsForOperationalFetch(from, to)
  const raw = includeLines
    ? await pageRows(async (start, end) => {
        let q = supabase
          .from("purchases")
          .select(
            "id, total, status, supplier_id, supplier_name, created_by, received_at, document_date, created_at, line_items",
          )
          .eq("pop_id", popId)
          .neq("status", "draft")
          .order("created_at", { ascending: true })
          .range(start, end)
        if (bounds.from) q = q.gte("created_at", `${bounds.from}T00:00:00`)
        if (bounds.to) q = q.lte("created_at", `${bounds.to}T23:59:59.999`)
        const { data } = await q
        return data || []
      })
    : await pageRows(async (start, end) => {
        let q = supabase
          .from("purchases")
          .select(
            "id, total, status, supplier_id, supplier_name, created_by, received_at, document_date, created_at",
          )
          .eq("pop_id", popId)
          .neq("status", "draft")
          .order("created_at", { ascending: true })
          .range(start, end)
        if (bounds.from) q = q.gte("created_at", `${bounds.from}T00:00:00`)
        if (bounds.to) q = q.lte("created_at", `${bounds.to}T23:59:59.999`)
        const { data } = await q
        return data || []
      })

  const userNames = includeUserNames
    ? await loadUserDisplayNames(
        supabase,
        raw.map((row) => (row.created_by != null ? String(row.created_by) : "")),
      )
    : new Map<string, string>()

  const mapped: SlimPurchase[] = raw.map((row) => ({
    id: String(row.id),
    occurredAt: purchaseAnchor(row),
    total: parseMoney(row.total),
    supplierId: row.supplier_id != null ? String(row.supplier_id) : null,
    supplierName: row.supplier_name != null ? String(row.supplier_name) : null,
    createdBy: row.created_by != null ? String(row.created_by) : null,
    purchasedByName: row.created_by
      ? (userNames.get(String(row.created_by)) ?? "Usuario")
      : null,
    lineItems:
      includeLines && "line_items" in row ? parseLines(row.line_items) : [],
  }))

  const purchases = mapped.filter((purchase) => {
    if (supplier && (purchase.supplierName ?? "") !== supplier) return false
    if (!from && !to) return true
    return isOperationalDayInRange(
      operationalDayKey(
        purchase.occurredAt,
        operational.timeZone,
        operational.operationalDayCloseTime,
      ),
      from,
      to,
    )
  })

  return {
    purchases,
    timeZone: operational.timeZone,
    operationalDayCloseTime: operational.operationalDayCloseTime,
  }
}

export function salesTotal(sales: SlimSale[]): number {
  return roundMoney(sales.reduce((sum, sale) => sum + sale.total, 0))
}

export function purchasesTotal(purchases: SlimPurchase[]): number {
  return roundMoney(purchases.reduce((sum, row) => sum + row.total, 0))
}
