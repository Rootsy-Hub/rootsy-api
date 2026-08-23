import type { SupabaseClient } from "@supabase/supabase-js"
import { mapSaleCatalogArticleRow, SALE_CATALOG_ARTICLE_SELECT } from "./articleMap.js"
import { resolveOpenCashSession } from "./cashSession.js"
import { loadSalePromotions, splitSalePromotions } from "./promotions.js"
import { loadPriceListOverrideMap } from "./priceList.js"
import {
  DEFAULT_SALE_SITE_ID,
  SALE_CATALOG_PAGE_SIZE,
  type SaleCatalogArticle,
  type SaleCatalogCategory,
  type SaleCatalogData,
  type SaleCatalogItemsPage,
  type SaleCatalogItemsQuery,
} from "./schema.js"

function sanitizeIlike(raw: string): string {
  return raw.replace(/[%_,()]/g, " ").replace(/\s+/g, " ").trim()
}

function saleArticlesBaseQuery(
  supabase: SupabaseClient,
  popId: string,
  visibleCategoryIds: string[],
) {
  return supabase
    .from("articles")
    .select(SALE_CATALOG_ARTICLE_SELECT)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .eq("is_sellable", true)
    .eq("item_kind", "merchandise")
    .in("category_id", visibleCategoryIds)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
}

async function mapArticlesWithPriceList(
  supabase: SupabaseClient,
  popId: string,
  priceListId: string | undefined,
  rows: Record<string, unknown>[],
): Promise<SaleCatalogArticle[]> {
  const overrides = await loadPriceListOverrideMap(
    supabase,
    popId,
    priceListId,
    "article",
    rows.map((row) => String(row.id)),
  )
  return rows.map((row) =>
    mapSaleCatalogArticleRow(row, overrides.get(String(row.id))),
  )
}

async function loadVisibleCategoryIds(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; ids: string[] }
  | { success: false; error: string }
> {
  const { data, error } = await supabase
    .from("categories")
    .select("id")
    .eq("pop_id", popId)
    .eq("show_in_sale", true)
  if (error) return { success: false, error: error.message }
  return { success: true, ids: (data ?? []).map((row) => String(row.id)) }
}

export async function loadSaleCatalog(
  supabase: SupabaseClient,
  popId: string,
  userId: string | undefined,
  caps: { canCreateSale: boolean },
): Promise<
  | { success: true; data: SaleCatalogData }
  | { success: false; error: string }
> {
  const [popNameResult, catResult, allPromotions] = await Promise.all([
    supabase.from("pops").select("name").eq("id", popId).maybeSingle(),
    supabase
      .from("categories")
      .select("id, name, sort_order")
      .eq("pop_id", popId)
      .eq("show_in_sale", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    loadSalePromotions(supabase, popId),
  ])

  if (popNameResult.error) {
    return { success: false, error: popNameResult.error.message }
  }
  if (catResult.error) {
    return { success: false, error: catResult.error.message }
  }

  const categories: SaleCatalogCategory[] = (catResult.data || []).map((c) => ({
    id: String(c.id),
    name: String(c.name ?? ""),
    sortOrder: Number(c.sort_order ?? 0) || 0,
  }))
  const { promotions, quantityDeals } = splitSalePromotions(allPromotions)
  const categorySections: SaleCatalogData["categorySections"] = [
    { id: "products", label: "Productos", categories },
  ]
  if (promotions.length > 0) {
    categorySections.unshift({
      id: "promotions",
      label: "Promociones",
      categories: [{ id: "all", name: "Promociones", sortOrder: 0 }],
    })
  }

  return {
    success: true,
    data: {
      popName: popNameResult.data?.name ? String(popNameResult.data.name) : "",
      categories,
      categorySections,
      promotions,
      quantityDeals,
      canReadClients: true,
      canReadPaymentMethods: true,
      canCreateSale: caps.canCreateSale,
      canReadCashRegisters: true,
      openCashSession: await resolveOpenCashSession(supabase, popId, userId),
      invoiceTypeSiteId: DEFAULT_SALE_SITE_ID,
    },
  }
}

export async function loadSaleCatalogItemsPage(
  supabase: SupabaseClient,
  popId: string,
  filter: SaleCatalogItemsQuery,
): Promise<
  | { success: true; data: SaleCatalogItemsPage }
  | { success: false; error: string }
> {
  if (filter.section === "promotions" && !filter.search) {
    return { success: true, data: { items: [], nextOffset: null } }
  }

  const visible = await loadVisibleCategoryIds(supabase, popId)
  if (!visible.success) return visible
  if (visible.ids.length === 0) {
    return { success: true, data: { items: [], nextOffset: null } }
  }

  const search = sanitizeIlike(filter.search)
  const scopedIds =
    search && filter.categoryIds && filter.categoryIds.length > 0
      ? visible.ids.filter((id) => filter.categoryIds!.includes(id))
      : visible.ids
  if (scopedIds.length === 0) {
    return { success: true, data: { items: [], nextOffset: null } }
  }
  let query = saleArticlesBaseQuery(supabase, popId, scopedIds)
  if (search) {
    query = query.or(
      `name.ilike.%${search}%,description.ilike.%${search}%,barcode.ilike.%${search}%`,
    )
  } else if (filter.section === "discounts") {
    query = query.not("discount_value", "is", null).gt("discount_value", 0)
  } else if (filter.categoryId) {
    query = query.eq("category_id", filter.categoryId)
  } else {
    return { success: true, data: { items: [], nextOffset: null } }
  }

  const from = Math.max(0, filter.offset)
  const to = from + SALE_CATALOG_PAGE_SIZE
  const { data, error } = await query.range(from, to)
  if (error) return { success: false, error: error.message }

  const rows = (data ?? []) as Record<string, unknown>[]
  const hasMore = rows.length > SALE_CATALOG_PAGE_SIZE
  const pageRows = rows.slice(0, SALE_CATALOG_PAGE_SIZE)
  const items = await mapArticlesWithPriceList(
    supabase,
    popId,
    filter.priceListId,
    pageRows,
  )
  return {
    success: true,
    data: {
      items,
      nextOffset: hasMore ? from + SALE_CATALOG_PAGE_SIZE : null,
    },
  }
}

export async function loadSaleCatalogArticlesByIds(
  supabase: SupabaseClient,
  popId: string,
  ids: string[],
  priceListId?: string,
): Promise<
  | { success: true; data: SaleCatalogArticle[] }
  | { success: false; error: string }
> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return { success: true, data: [] }

  const { data, error } = await supabase
    .from("articles")
    .select(SALE_CATALOG_ARTICLE_SELECT)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .in("id", unique)
  if (error) return { success: false, error: error.message }

  return {
    success: true,
    data: await mapArticlesWithPriceList(
      supabase,
      popId,
      priceListId,
      (data ?? []) as Record<string, unknown>[],
    ),
  }
}

export async function findSaleCatalogArticleByScan(
  supabase: SupabaseClient,
  popId: string,
  rawQuery: string,
  priceListId?: string,
): Promise<
  | { success: true; data: SaleCatalogArticle | null }
  | { success: false; error: string }
> {
  const query = rawQuery.trim()
  if (!query) return { success: true, data: null }

  const visible = await loadVisibleCategoryIds(supabase, popId)
  if (!visible.success) return visible
  if (visible.ids.length === 0) return { success: true, data: null }

  const base = saleArticlesBaseQuery(supabase, popId, visible.ids)
  const { data: barcodeRows, error: barcodeError } = await base
    .eq("barcode", query)
    .limit(2)
  if (barcodeError) return { success: false, error: barcodeError.message }
  if ((barcodeRows ?? []).length === 1) {
    const [article] = await mapArticlesWithPriceList(
      supabase,
      popId,
      priceListId,
      [barcodeRows![0] as Record<string, unknown>],
    )
    return { success: true, data: article ?? null }
  }
  if ((barcodeRows ?? []).length > 1) return { success: true, data: null }

  const { data: nameRows, error: nameError } = await saleArticlesBaseQuery(
    supabase,
    popId,
    visible.ids,
  )
    .ilike("name", query)
    .limit(2)
  if (nameError) return { success: false, error: nameError.message }
  if ((nameRows ?? []).length === 1) {
    const [article] = await mapArticlesWithPriceList(
      supabase,
      popId,
      priceListId,
      [nameRows![0] as Record<string, unknown>],
    )
    return { success: true, data: article ?? null }
  }
  return { success: true, data: null }
}
