import type { SupabaseClient } from "@supabase/supabase-js"
import {
  ARTICLE_DISCOUNT_MODES,
  ARTICLE_ITEM_KINDS,
  type ArticleCostRow,
  type ArticleDiscountMode,
  type ArticleItemKind,
  type ArticleListData,
  type ArticleListPriceRow,
  type ArticleRow,
  type ListArticlesQuery,
} from "./schema.js"

const ARTICLE_SELECT = `
  id,
  name,
  description,
  image_url,
  brand,
  sku,
  barcode,
  item_kind,
  unit_of_measure,
  is_sellable,
  default_waste_pct,
  min_stock_level,
  sale_price,
  iva,
  discount_mode,
  discount_value,
  category_id,
  is_active,
  allow_negative_stock,
  categories ( id, name )
`

const ARTICLE_COST_SELECT = `
  id,
  pop_id,
  article_id,
  supplier_id,
  name,
  cost_unit_label,
  sale_units_per_cost_unit,
  unit_price,
  is_active,
  sort_order,
  created_at,
  updated_at,
  suppliers ( id, name )
`

const ARTICLE_LIST_SORT: Record<string, string> = {
  name: "name",
  sale_price: "sale_price",
}

function isItemKind(v: string): v is ArticleItemKind {
  return (ARTICLE_ITEM_KINDS as readonly string[]).includes(v)
}

function isDiscountMode(v: string): v is ArticleDiscountMode {
  return (ARTICLE_DISCOUNT_MODES as readonly string[]).includes(v)
}

function parseStockQty(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 1e6) / 1e6
}

function nestedName(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const name = (raw as { name?: unknown }).name
  return typeof name === "string" && name.trim() ? name.trim() : null
}

function mapCostRow(row: Record<string, unknown>): ArticleCostRow {
  return {
    id: String(row.id),
    popId: String(row.pop_id),
    articleId: String(row.article_id),
    supplierId: row.supplier_id != null ? String(row.supplier_id) : null,
    supplierName: nestedName(row.suppliers),
    name: String(row.name ?? ""),
    costUnitLabel: String(row.cost_unit_label ?? ""),
    saleUnitsPerCostUnit: Number(row.sale_units_per_cost_unit ?? 0) || 0,
    unitPrice: Number(row.unit_price ?? 0) || 0,
    isActive: Boolean(row.is_active ?? true),
    sortOrder: Number(row.sort_order ?? 0) || 0,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

function mapArticleBase(row: Record<string, unknown>): Omit<
  ArticleRow,
  "stockOnHand" | "activeCostCount" | "costs" | "listPrices"
> {
  const cat = row.categories as { name?: string } | null
  const rawImg = row.image_url
  const imageUrl =
    typeof rawImg === "string" && rawImg.trim() !== "" ? rawImg.trim() : null
  const rawKind = String(row.item_kind ?? "merchandise")
  const itemKind = isItemKind(rawKind) ? rawKind : "merchandise"
  const rawUom = String(row.unit_of_measure ?? "unidad").trim()
  const unitOfMeasure = rawUom || "unidad"
  const wasteRaw = row.default_waste_pct
  const minRaw = row.min_stock_level
  const rawDiscountMode = row.discount_mode
  const discountMode =
    typeof rawDiscountMode === "string" && isDiscountMode(rawDiscountMode)
      ? rawDiscountMode
      : null
  const discountRaw = row.discount_value
  const discountValue =
    discountRaw != null && Number.isFinite(Number(discountRaw))
      ? Number(discountRaw)
      : null
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    imageUrl,
    brand: String(row.brand ?? ""),
    sku: row.sku != null && String(row.sku).trim() ? String(row.sku).trim() : null,
    barcode:
      row.barcode != null && String(row.barcode).trim()
        ? String(row.barcode).trim()
        : null,
    itemKind,
    unitOfMeasure,
    isSellable: Boolean(row.is_sellable),
    defaultWastePct:
      wasteRaw != null && Number.isFinite(Number(wasteRaw))
        ? Number(wasteRaw)
        : null,
    minStockLevel:
      minRaw != null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : null,
    salePrice: Number(row.sale_price ?? 0) || 0,
    iva: Number(row.iva ?? 0) || 0,
    discountMode,
    discountValue,
    categoryId: String(row.category_id ?? ""),
    categoryName: cat?.name ? String(cat.name) : "—",
    isActive: Boolean(row.is_active),
    allowNegativeStock: Boolean(row.allow_negative_stock),
  }
}

function articleMatchesStockFilter(
  stock: number,
  input: Pick<ListArticlesQuery, "conStock" | "sinStock" | "stockNegativo">,
): boolean {
  if (!input.conStock && !input.sinStock && !input.stockNegativo) return true
  const zero = Math.abs(stock) < 1e-6
  const positive = stock > 1e-6
  const negative = stock < -1e-6
  const checks: boolean[] = []
  if (input.conStock) checks.push(positive)
  if (input.sinStock) checks.push(zero)
  if (input.stockNegativo) checks.push(negative)
  return checks.some(Boolean)
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function buildSearchOrClause(raw: string): string | null {
  const t = raw.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  return `name.ilike.${pattern},description.ilike.${pattern},sku.ilike.${pattern},barcode.ilike.${pattern}`
}

function appendArticleFilters<
  Q extends {
    eq: (a: string, b: string | boolean) => Q
    or: (s: string) => Q
    in: (column: string, values: readonly string[]) => Q
    not: (column: string, operator: string, value: null) => Q
    gt: (column: string, value: number) => Q
  },
>(q: Q, input: ListArticlesQuery): Q {
  let x = q
  if (input.soloActivos) x = x.eq("is_active", true)
  if (input.soloInactivos) x = x.eq("is_active", false)
  if (input.conDescuento) {
    x = x.not("discount_mode", "is", null).gt("discount_value", 0)
  }
  if (input.sinDescuento) {
    x = x.or("discount_mode.is.null,discount_value.is.null,discount_value.lte.0")
  }
  if (input.ventaSinStock) x = x.eq("allow_negative_stock", true)
  if (
    input.itemKinds.length > 0 &&
    input.itemKinds.length < ARTICLE_ITEM_KINDS.length
  ) {
    x = x.in("item_kind", input.itemKinds)
  }
  if (input.categoryId) x = x.eq("category_id", input.categoryId)
  const orClause = buildSearchOrClause(input.search)
  if (orClause) x = x.or(orClause)
  return x
}

async function stockOnHandByArticleIds(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (articleIds.length === 0) return out

  const { data, error } = await supabase
    .from("inventory_on_hand")
    .select("article_id, quantity")
    .eq("pop_id", popId)
    .in("article_id", articleIds)

  if (error) return out

  for (const row of data ?? []) {
    const id = String(row.article_id)
    out.set(id, (out.get(id) ?? 0) + parseStockQty(row.quantity))
  }
  for (const [id, qty] of out) {
    out.set(id, Math.round(qty * 1e6) / 1e6)
  }
  return out
}

async function stockOnHandForPop(
  supabase: SupabaseClient,
  popId: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const { data, error } = await supabase
    .from("inventory_on_hand")
    .select("article_id, quantity")
    .eq("pop_id", popId)

  if (error) return out

  for (const row of data ?? []) {
    const id = String(row.article_id)
    out.set(id, (out.get(id) ?? 0) + parseStockQty(row.quantity))
  }
  for (const [id, qty] of out) {
    out.set(id, Math.round(qty * 1e6) / 1e6)
  }
  return out
}

async function costsByArticleIds(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, ArticleCostRow[]>> {
  const out = new Map<string, ArticleCostRow[]>()
  if (articleIds.length === 0) return out

  const { data, error } = await supabase
    .from("article_costs")
    .select(ARTICLE_COST_SELECT)
    .eq("pop_id", popId)
    .in("article_id", articleIds)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })

  if (error) return out

  for (const row of data ?? []) {
    const mapped = mapCostRow(row as Record<string, unknown>)
    const list = out.get(mapped.articleId) ?? []
    list.push(mapped)
    out.set(mapped.articleId, list)
  }
  return out
}

async function listPricesByArticleIds(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<Map<string, ArticleListPriceRow[]>> {
  const out = new Map<string, ArticleListPriceRow[]>()
  if (articleIds.length === 0) return out

  const { data, error } = await supabase
    .from("price_list_items")
    .select("item_id, price_list_id, amount")
    .eq("pop_id", popId)
    .eq("item_kind", "article")
    .in("item_id", articleIds)

  if (error) return out

  for (const row of data ?? []) {
    const articleId = String(row.item_id)
    const list = out.get(articleId) ?? []
    list.push({
      listId: String(row.price_list_id),
      amount: Number(row.amount ?? 0),
    })
    out.set(articleId, list)
  }
  return out
}

async function enrichArticles(
  supabase: SupabaseClient,
  popId: string,
  rows: Record<string, unknown>[],
): Promise<ArticleRow[]> {
  const bases = rows.map((row) => mapArticleBase(row))
  const ids = bases.map((row) => row.id)
  const [stockById, costsById, pricesById] = await Promise.all([
    stockOnHandByArticleIds(supabase, popId, ids),
    costsByArticleIds(supabase, popId, ids),
    listPricesByArticleIds(supabase, popId, ids),
  ])

  return bases.map((row) => {
    const costs = costsById.get(row.id) ?? []
    return {
      ...row,
      stockOnHand: stockById.get(row.id) ?? 0,
      activeCostCount: costs.filter((cost) => cost.isActive).length,
      costs,
      listPrices: pricesById.get(row.id) ?? [],
    }
  })
}

export async function listArticles(
  supabase: SupabaseClient,
  popId: string,
  input: ListArticlesQuery,
  caps: Pick<
    ArticleListData,
    "canCreate" | "canPostInitialStock" | "canUpdate" | "canDelete"
  >,
): Promise<
  { success: true; data: ArticleListData } | { success: false; error: string }
> {
  const needsStockFilter =
    input.conStock || input.sinStock || input.stockNegativo
  let stockArticleIds: string[] | null = null

  if (needsStockFilter) {
    let idQuery = supabase.from("articles").select("id").eq("pop_id", popId)
    idQuery = appendArticleFilters(idQuery, input)
    const { data: idRows, error: idErr } = await idQuery
    if (idErr) return { success: false, error: idErr.message }

    const stockById = await stockOnHandForPop(supabase, popId)
    stockArticleIds = (idRows ?? [])
      .map((row) => String(row.id))
      .filter((id) => articleMatchesStockFilter(stockById.get(id) ?? 0, input))

    if (stockArticleIds.length === 0) {
      return {
        success: true,
        data: {
          articles: [],
          totalCount: 0,
          page: 1,
          pageSize: input.pageSize,
          ...caps,
        },
      }
    }
  }

  let countQuery = supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  countQuery = appendArticleFilters(countQuery, input)
  if (stockArticleIds) countQuery = countQuery.in("id", stockArticleIds)

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const sortColumn = input.sort ? ARTICLE_LIST_SORT[input.sort] : undefined
  const column = sortColumn ?? "name"
  const ascending = sortColumn ? input.ord === "asc" : true

  let dataQuery = supabase
    .from("articles")
    .select(ARTICLE_SELECT)
    .eq("pop_id", popId)
  dataQuery = appendArticleFilters(dataQuery, input)
  if (stockArticleIds) dataQuery = dataQuery.in("id", stockArticleIds)
  dataQuery = dataQuery.order(column, { ascending }).range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  const articles = await enrichArticles(
    supabase,
    popId,
    (data ?? []) as Record<string, unknown>[],
  )

  return {
    success: true,
    data: {
      articles,
      totalCount,
      page,
      pageSize: input.pageSize,
      ...caps,
    },
  }
}

export async function getArticle(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
): Promise<
  | { success: true; data: ArticleRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("articles")
    .select(ARTICLE_SELECT)
    .eq("pop_id", popId)
    .eq("id", articleId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) return { success: false, error: "Artículo no encontrado", status: 404 }

  const [article] = await enrichArticles(supabase, popId, [
    data as Record<string, unknown>,
  ])
  return { success: true, data: article }
}
