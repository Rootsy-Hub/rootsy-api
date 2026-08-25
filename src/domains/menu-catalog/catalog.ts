import type { SupabaseClient } from "@supabase/supabase-js"
import { mapSaleCatalogArticleRow, SALE_CATALOG_ARTICLE_SELECT } from "../sale/articleMap.js"
import { resolveOpenCashSession } from "../sale/cashSession.js"
import { loadPriceListOverrideMap } from "../sale/priceList.js"
import { loadSalePromotions, splitMenuPromotions } from "../sale/promotions.js"
import {
  DEFAULT_SALE_SITE_ID,
  SALE_CATALOG_PAGE_SIZE,
  type MenuCatalogCaps,
  type MenuCatalogData,
  type MenuCatalogItemsPage,
  type MenuCatalogItemsQuery,
  type MenuCatalogRecipe,
  type SaleCatalogArticle,
  type SaleCatalogCategory,
} from "./schema.js"

export const MENU_RECIPE_SELECT = `
  id,
  name,
  description,
  sale_price,
  iva,
  image_url,
  category_id,
  recipe_categories ( id, name, station_id )
` as const

function sanitizeIlike(raw: string): string {
  return raw.replace(/[%_,()]/g, " ").replace(/\s+/g, " ").trim()
}

export function mapMenuRecipeRow(
  row: Record<string, unknown>,
  listPriceOverride?: number,
): MenuCatalogRecipe {
  const cat = row.recipe_categories as {
    name?: string
    station_id?: string | null
  } | null
  const rawImg = row.image_url
  const principal = Number(row.sale_price ?? 0) || 0
  const stationId =
    typeof cat?.station_id === "string" && cat.station_id.trim()
      ? cat.station_id.trim()
      : null
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    salePrice:
      listPriceOverride != null && Number.isFinite(listPriceOverride)
        ? listPriceOverride
        : principal,
    iva: Number(row.iva ?? 0) || 0,
    categoryId: String(row.category_id ?? ""),
    categoryName: cat?.name ? String(cat.name) : "—",
    imageUrl:
      typeof rawImg === "string" && rawImg.trim() !== "" ? rawImg.trim() : null,
    stationId,
  }
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

async function mapRecipesWithPriceList(
  supabase: SupabaseClient,
  popId: string,
  priceListId: string | undefined,
  rows: Record<string, unknown>[],
): Promise<MenuCatalogRecipe[]> {
  const overrides = await loadPriceListOverrideMap(
    supabase,
    popId,
    priceListId,
    "recipe",
    rows.map((row) => String(row.id)),
  )
  return rows.map((row) => mapMenuRecipeRow(row, overrides.get(String(row.id))))
}

export async function loadMenuCatalog(
  supabase: SupabaseClient,
  popId: string,
  userId: string | undefined,
  caps: MenuCatalogCaps,
): Promise<
  | { success: true; data: MenuCatalogData }
  | { success: false; error: string }
> {
  const [popNameResult, recipeCatResult, productCatResult, allPromotions] =
    await Promise.all([
      supabase.from("pops").select("name").eq("id", popId).maybeSingle(),
      supabase
        .from("recipe_categories")
        .select("id, name, sort_order")
        .eq("pop_id", popId)
        .eq("is_active", true)
        .eq("show_in_menu", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
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
  if (recipeCatResult.error) {
    return { success: false, error: recipeCatResult.error.message }
  }
  if (productCatResult.error) {
    return { success: false, error: productCatResult.error.message }
  }

  const mapCategory = (c: {
    id: unknown
    name?: unknown
    sort_order?: unknown
  }): SaleCatalogCategory => ({
    id: String(c.id),
    name: String(c.name ?? ""),
    sortOrder: Number(c.sort_order ?? 0) || 0,
  })

  const recipeCategories = (recipeCatResult.data ?? []).map(mapCategory)
  const productCategories = (productCatResult.data ?? []).map(mapCategory)
  const { promotions, quantityDeals } = splitMenuPromotions(allPromotions)

  const categorySections: MenuCatalogData["categorySections"] = [
    { id: "recipes", label: "Recetas", categories: recipeCategories },
    { id: "products", label: "Productos", categories: productCategories },
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
      categorySections,
      promotions,
      quantityDeals,
      canReadClients: caps.canReadClients,
      canReadPaymentMethods: caps.canReadPaymentMethods,
      canCreateSale: caps.canCreateSale,
      canReadCashRegisters: caps.canReadCashRegisters,
      openCashSession: caps.canReadCashRegisters
        ? await resolveOpenCashSession(supabase, popId, userId)
        : null,
      invoiceTypeSiteId: DEFAULT_SALE_SITE_ID,
    },
  }
}

export async function loadMenuCatalogItemsPage(
  supabase: SupabaseClient,
  popId: string,
  filter: MenuCatalogItemsQuery,
): Promise<
  | { success: true; data: MenuCatalogItemsPage }
  | { success: false; error: string }
> {
  if (filter.section === "promotions" && !filter.search) {
    return {
      success: true,
      data: { articles: [], recipes: [], nextOffset: null },
    }
  }

  const search = sanitizeIlike(filter.search)
  const from = Math.max(0, filter.offset)
  const to = from + SALE_CATALOG_PAGE_SIZE
  const wantArticles =
    filter.section === "products" ||
    filter.section === "all" ||
    filter.section === "discounts" ||
    Boolean(search)
  const wantRecipes =
    filter.section === "recipes" ||
    filter.section === "all" ||
    Boolean(search)

  const [productCatResult, recipeCatResult] = await Promise.all([
    wantArticles
      ? supabase
          .from("categories")
          .select("id")
          .eq("pop_id", popId)
          .eq("show_in_sale", true)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
    wantRecipes
      ? supabase
          .from("recipe_categories")
          .select("id")
          .eq("pop_id", popId)
          .eq("is_active", true)
          .eq("show_in_menu", true)
      : Promise.resolve({ data: [] as { id: string }[], error: null }),
  ])
  if (productCatResult.error) {
    return { success: false, error: productCatResult.error.message }
  }
  if (recipeCatResult.error) {
    return { success: false, error: recipeCatResult.error.message }
  }

  const visibleProductIds = (productCatResult.data ?? []).map((row) =>
    String(row.id),
  )
  const visibleRecipeIds = (recipeCatResult.data ?? []).map((row) =>
    String(row.id),
  )

  let articleHasMore = false
  let recipeHasMore = false
  let articles: SaleCatalogArticle[] = []
  let recipes: MenuCatalogRecipe[] = []

  if (wantArticles && visibleProductIds.length > 0) {
    let query = supabase
      .from("articles")
      .select(SALE_CATALOG_ARTICLE_SELECT)
      .eq("pop_id", popId)
      .eq("is_active", true)
      .eq("is_sellable", true)
      .eq("item_kind", "merchandise")
      .in("category_id", visibleProductIds)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,description.ilike.%${search}%,barcode.ilike.%${search}%`,
      )
    } else if (filter.section === "discounts") {
      query = query.not("discount_value", "is", null).gt("discount_value", 0)
    } else if (filter.categoryId) {
      query = query.eq("category_id", filter.categoryId)
    }
    const { data, error } = await query.range(from, to)
    if (error) return { success: false, error: error.message }
    const rows = (data ?? []) as Record<string, unknown>[]
    articleHasMore = rows.length > SALE_CATALOG_PAGE_SIZE
    const pageRows = rows.slice(0, SALE_CATALOG_PAGE_SIZE)
    articles = await mapArticlesWithPriceList(
      supabase,
      popId,
      filter.priceListId,
      pageRows,
    )
  }

  if (wantRecipes && visibleRecipeIds.length > 0) {
    let query = supabase
      .from("recipes")
      .select(MENU_RECIPE_SELECT)
      .eq("pop_id", popId)
      .eq("is_active", true)
      .in("category_id", visibleRecipeIds)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`)
    } else if (filter.categoryId && filter.section === "recipes") {
      query = query.eq("category_id", filter.categoryId)
    }
    const { data, error } = await query.range(from, to)
    if (error) return { success: false, error: error.message }
    const rows = (data ?? []) as Record<string, unknown>[]
    recipeHasMore = rows.length > SALE_CATALOG_PAGE_SIZE
    const pageRows = rows.slice(0, SALE_CATALOG_PAGE_SIZE)
    recipes = await mapRecipesWithPriceList(
      supabase,
      popId,
      filter.priceListId,
      pageRows,
    )
  }

  return {
    success: true,
    data: {
      articles,
      recipes,
      nextOffset:
        articleHasMore || recipeHasMore
          ? from + SALE_CATALOG_PAGE_SIZE
          : null,
    },
  }
}

export async function loadMenuCatalogItemsByIds(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
  recipeIds: string[],
  priceListId?: string,
): Promise<
  | {
      success: true
      data: { articles: SaleCatalogArticle[]; recipes: MenuCatalogRecipe[] }
    }
  | { success: false; error: string }
> {
  const uniqueArticles = [...new Set(articleIds.filter(Boolean))]
  const uniqueRecipes = [...new Set(recipeIds.filter(Boolean))]
  const [artRes, recipeRes] = await Promise.all([
    uniqueArticles.length > 0
      ? supabase
          .from("articles")
          .select(SALE_CATALOG_ARTICLE_SELECT)
          .eq("pop_id", popId)
          .in("id", uniqueArticles)
      : Promise.resolve({ data: [] as never[], error: null }),
    uniqueRecipes.length > 0
      ? supabase
          .from("recipes")
          .select(MENU_RECIPE_SELECT)
          .eq("pop_id", popId)
          .in("id", uniqueRecipes)
      : Promise.resolve({ data: [] as never[], error: null }),
  ])
  if (artRes.error) return { success: false, error: artRes.error.message }
  if (recipeRes.error) return { success: false, error: recipeRes.error.message }

  const [articles, recipes] = await Promise.all([
    mapArticlesWithPriceList(
      supabase,
      popId,
      priceListId,
      (artRes.data ?? []) as Record<string, unknown>[],
    ),
    mapRecipesWithPriceList(
      supabase,
      popId,
      priceListId,
      (recipeRes.data ?? []) as Record<string, unknown>[],
    ),
  ])
  return { success: true, data: { articles, recipes } }
}

export async function findMenuCatalogItemByScan(
  supabase: SupabaseClient,
  popId: string,
  rawQuery: string,
  priceListId?: string,
): Promise<
  | {
      success: true
      data: { article: SaleCatalogArticle | null; recipe: MenuCatalogRecipe | null }
    }
  | { success: false; error: string }
> {
  const query = rawQuery.trim()
  if (!query) {
    return { success: true, data: { article: null, recipe: null } }
  }

  const { data: barcodeRows, error: barcodeError } = await supabase
    .from("articles")
    .select(SALE_CATALOG_ARTICLE_SELECT)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .eq("is_sellable", true)
    .eq("item_kind", "merchandise")
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
    return { success: true, data: { article: article ?? null, recipe: null } }
  }
  if ((barcodeRows ?? []).length > 1) {
    return { success: true, data: { article: null, recipe: null } }
  }

  const { data: articleNameRows, error: articleNameError } = await supabase
    .from("articles")
    .select(SALE_CATALOG_ARTICLE_SELECT)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .eq("is_sellable", true)
    .eq("item_kind", "merchandise")
    .ilike("name", query)
    .limit(2)
  if (articleNameError) return { success: false, error: articleNameError.message }
  if ((articleNameRows ?? []).length === 1) {
    const [article] = await mapArticlesWithPriceList(
      supabase,
      popId,
      priceListId,
      [articleNameRows![0] as Record<string, unknown>],
    )
    return { success: true, data: { article: article ?? null, recipe: null } }
  }

  const { data: recipeNameRows, error: recipeNameError } = await supabase
    .from("recipes")
    .select(MENU_RECIPE_SELECT)
    .eq("pop_id", popId)
    .eq("is_active", true)
    .ilike("name", query)
    .limit(2)
  if (recipeNameError) return { success: false, error: recipeNameError.message }
  if ((recipeNameRows ?? []).length === 1) {
    const [recipe] = await mapRecipesWithPriceList(
      supabase,
      popId,
      priceListId,
      [recipeNameRows![0] as Record<string, unknown>],
    )
    return { success: true, data: { article: null, recipe: recipe ?? null } }
  }
  return { success: true, data: { article: null, recipe: null } }
}
