import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveArticleReferenceUnitCostsByArticleId } from "./articleReferenceCost.js"
import { computeRecipeCostPrice } from "./recipeCost.js"
import {
  RECIPE_INGREDIENT_ITEM_KINDS,
  RECIPE_INGREDIENT_SEARCH_LIMIT,
  type ListRecipesQuery,
  type RecipeDetail,
  type RecipeIngredientItemKind,
  type RecipeIngredientOption,
  type RecipeIngredientRow,
  type RecipeListData,
  type RecipeListPriceRow,
  type RecipeRow,
} from "./schema.js"

const RECIPE_SELECT = `
  id,
  pop_id,
  category_id,
  name,
  description,
  sale_price,
  cost_price,
  iva,
  image_url,
  is_active,
  allow_negative_stock,
  output_article_id,
  articles!recipes_output_article_id_fkey ( id, name, unit_of_measure ),
  recipe_categories ( name )
`

const INGREDIENT_SELECT = `
  id,
  article_id,
  quantity,
  waste_pct,
  sort_order,
  articles (
    id,
    name,
    item_kind,
    unit_of_measure,
    default_waste_pct
  )
`

const RECIPE_LIST_SORT: Record<string, string> = {
  name: "name",
  sale_price: "sale_price",
  cost_price: "cost_price",
}

function isIngredientKind(v: string): v is RecipeIngredientItemKind {
  return (RECIPE_INGREDIENT_ITEM_KINDS as readonly string[]).includes(v)
}

function normalizeStoredUnitOfMeasure(
  raw: string | null | undefined,
  fallback = "kg",
): string {
  const trimmed = String(raw ?? "").trim()
  return trimmed || fallback
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function mapRecipeRow(
  row: Record<string, unknown>,
  ingredientCount = 0,
  listPrices: RecipeListPriceRow[] = [],
): RecipeRow {
  const cat = row.recipe_categories as { name?: string } | null
  const outArt = row.articles as { id?: string; name?: string } | null
  const rawImg = row.image_url
  const imageUrl =
    typeof rawImg === "string" && rawImg.trim() !== "" ? rawImg.trim() : null
  const outputArticleId = row.output_article_id
    ? String(row.output_article_id)
    : outArt?.id
      ? String(outArt.id)
      : null
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    imageUrl,
    categoryId: row.category_id ? String(row.category_id) : null,
    categoryName: cat?.name ? String(cat.name) : "—",
    salePrice: Number(row.sale_price ?? 0) || 0,
    costPrice: Number(row.cost_price ?? 0) || 0,
    iva: Number(row.iva ?? 0) || 0,
    ingredientCount,
    isActive: Boolean(row.is_active),
    allowNegativeStock: Boolean(row.allow_negative_stock),
    outputArticleId,
    outputArticleName: outArt?.name ? String(outArt.name) : null,
    listPrices,
  }
}

function mapIngredientRow(
  row: Record<string, unknown>,
  referenceUnitCostByArticleId: Map<string, number>,
): RecipeIngredientRow | null {
  const art = row.articles as Record<string, unknown> | null
  if (!art?.id) return null
  const articleId = String(art.id)
  const rawKind = String(art.item_kind ?? "raw_material")
  const itemKind = isIngredientKind(rawKind) ? rawKind : "raw_material"
  const quantity = Number(row.quantity ?? 0)
  const wasteRaw = row.waste_pct
  const wastePct =
    wasteRaw != null && Number.isFinite(Number(wasteRaw))
      ? Number(wasteRaw)
      : null
  const articleCostPrice = referenceUnitCostByArticleId.get(articleId) ?? 0
  const wasteDefaultRaw = art.default_waste_pct
  const articleDefaultWastePct =
    wasteDefaultRaw != null && Number.isFinite(Number(wasteDefaultRaw))
      ? Number(wasteDefaultRaw)
      : null
  const lineCost = computeRecipeCostPrice([
    {
      quantity,
      wastePct,
      articleCostPrice,
      articleDefaultWastePct,
    },
  ])
  return {
    id: String(row.id),
    articleId,
    articleName: String(art.name ?? ""),
    itemKind,
    unitOfMeasure: normalizeStoredUnitOfMeasure(
      String(art.unit_of_measure ?? "kg"),
      "kg",
    ),
    quantity,
    wastePct,
    articleCostPrice,
    articleDefaultWastePct,
    lineCost,
  }
}

function mapIngredientOptions(
  rows: Array<Record<string, unknown>>,
  referenceUnitCosts: Map<string, number>,
): RecipeIngredientOption[] {
  return rows.map((r) => {
    const id = String(r.id)
    const rawKind = String(r.item_kind ?? "raw_material")
    const wasteRaw = r.default_waste_pct
    return {
      id,
      name: String(r.name ?? ""),
      itemKind: isIngredientKind(rawKind) ? rawKind : "raw_material",
      unitOfMeasure: normalizeStoredUnitOfMeasure(
        String(r.unit_of_measure ?? "kg"),
        "kg",
      ),
      costPrice: referenceUnitCosts.get(id) ?? 0,
      defaultWastePct:
        wasteRaw != null && Number.isFinite(Number(wasteRaw))
          ? Number(wasteRaw)
          : null,
    }
  })
}

async function listPricesByRecipeIds(
  supabase: SupabaseClient,
  popId: string,
  recipeIds: string[],
): Promise<Map<string, RecipeListPriceRow[]>> {
  const out = new Map<string, RecipeListPriceRow[]>()
  if (recipeIds.length === 0) return out

  const { data, error } = await supabase
    .from("price_list_items")
    .select("item_id, price_list_id, amount")
    .eq("pop_id", popId)
    .eq("item_kind", "recipe")
    .in("item_id", recipeIds)

  if (error) return out

  for (const row of data ?? []) {
    const recipeId = String(row.item_id)
    const list = out.get(recipeId) ?? []
    list.push({
      listId: String(row.price_list_id),
      amount: Number(row.amount ?? 0),
    })
    out.set(recipeId, list)
  }
  return out
}

export async function listRecipes(
  supabase: SupabaseClient,
  popId: string,
  input: ListRecipesQuery,
  caps: Pick<RecipeListData, "canCreate" | "canUpdate" | "canDelete">,
): Promise<
  { success: true; data: RecipeListData } | { success: false; error: string }
> {
  let countQuery = supabase
    .from("recipes")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  if (input.soloActivos) countQuery = countQuery.eq("is_active", true)
  if (input.categoryId) countQuery = countQuery.eq("category_id", input.categoryId)
  if (input.search) {
    const pattern = `%${escapeIlikeToken(input.search)}%`
    countQuery = countQuery.or(
      `name.ilike.${pattern},description.ilike.${pattern}`,
    )
  }

  const { count: countRaw, error: countErr } = await countQuery
  if (countErr) return { success: false, error: countErr.message }

  const totalCount = countRaw ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const from = (page - 1) * input.pageSize
  const to = from + input.pageSize - 1
  const sortColumn = input.sort ? RECIPE_LIST_SORT[input.sort] : undefined
  const column = sortColumn ?? "name"
  const ascending = sortColumn ? input.ord === "asc" : true

  let dataQuery = supabase
    .from("recipes")
    .select(RECIPE_SELECT)
    .eq("pop_id", popId)
  if (input.soloActivos) dataQuery = dataQuery.eq("is_active", true)
  if (input.categoryId) dataQuery = dataQuery.eq("category_id", input.categoryId)
  if (input.search) {
    const pattern = `%${escapeIlikeToken(input.search)}%`
    dataQuery = dataQuery.or(
      `name.ilike.${pattern},description.ilike.${pattern}`,
    )
  }
  dataQuery = dataQuery.order(column, { ascending }).range(from, to)

  const { data, error } = await dataQuery
  if (error) return { success: false, error: error.message }

  const recipeIds = (data ?? []).map((row) => String(row.id))
  const ingredientCounts = new Map<string, number>()
  if (recipeIds.length > 0) {
    const { data: ingRows } = await supabase
      .from("recipe_ingredients")
      .select("recipe_id")
      .eq("pop_id", popId)
      .in("recipe_id", recipeIds)
    for (const row of ingRows ?? []) {
      const id = String(row.recipe_id)
      ingredientCounts.set(id, (ingredientCounts.get(id) ?? 0) + 1)
    }
  }

  return {
    success: true,
    data: {
      recipes: (data ?? []).map((row) =>
        mapRecipeRow(
          row as Record<string, unknown>,
          ingredientCounts.get(String(row.id)) ?? 0,
        ),
      ),
      totalCount,
      page,
      pageSize: input.pageSize,
      ...caps,
    },
  }
}

export async function getRecipe(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
): Promise<
  | { success: true; data: RecipeDetail }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("recipes")
    .select(RECIPE_SELECT)
    .eq("id", recipeId)
    .eq("pop_id", popId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Receta no encontrada.", status: 404 }
  }

  const { data: ingData, error: ingErr } = await supabase
    .from("recipe_ingredients")
    .select(INGREDIENT_SELECT)
    .eq("recipe_id", recipeId)
    .eq("pop_id", popId)
    .order("sort_order", { ascending: true })
  if (ingErr) return { success: false, error: ingErr.message, status: 500 }

  const ingredientArticleIds = (ingData ?? [])
    .map((r) => {
      const art = (r as Record<string, unknown>).articles as
        | Record<string, unknown>
        | null
      return art?.id ? String(art.id) : null
    })
    .filter((id): id is string => id != null)

  const [referenceUnitCosts, pricesById] = await Promise.all([
    resolveArticleReferenceUnitCostsByArticleId(
      supabase,
      popId,
      ingredientArticleIds,
    ),
    listPricesByRecipeIds(supabase, popId, [recipeId]),
  ])

  const ingredients = (ingData ?? [])
    .map((r) =>
      mapIngredientRow(r as Record<string, unknown>, referenceUnitCosts),
    )
    .filter((r): r is RecipeIngredientRow => r != null)

  return {
    success: true,
    data: {
      ...mapRecipeRow(
        data as Record<string, unknown>,
        ingredients.length,
        pricesById.get(recipeId) ?? [],
      ),
      ingredients,
    },
  }
}

export async function searchRecipeIngredients(
  supabase: SupabaseClient,
  popId: string,
  query: string,
  excludeIds: string[] = [],
): Promise<
  | { success: true; data: RecipeIngredientOption[] }
  | { success: false; error: string }
> {
  const term = query.trim()
  if (!term) return { success: true, data: [] }

  const pattern = `%${escapeIlikeToken(term)}%`
  const blocked = excludeIds.map((id) => id.trim()).filter(Boolean)
  let q = supabase
    .from("articles")
    .select("id, name, item_kind, unit_of_measure, default_waste_pct")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .in("item_kind", [...RECIPE_INGREDIENT_ITEM_KINDS])
    .or(`name.ilike.${pattern},sku.ilike.${pattern}`)
    .order("name", { ascending: true })
    .limit(RECIPE_INGREDIENT_SEARCH_LIMIT)
  if (blocked.length > 0) {
    q = q.not("id", "in", `(${blocked.join(",")})`)
  }
  const { data, error } = await q
  if (error) return { success: false, error: error.message }

  const rows = (data ?? []) as Array<Record<string, unknown>>
  const referenceUnitCosts = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    rows.map((r) => String(r.id)),
  )
  return { success: true, data: mapIngredientOptions(rows, referenceUnitCosts) }
}

export async function getRecipeIngredientsByIds(
  supabase: SupabaseClient,
  popId: string,
  articleIds: string[],
): Promise<
  | { success: true; data: RecipeIngredientOption[] }
  | { success: false; error: string }
> {
  const ids = [...new Set(articleIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) return { success: true, data: [] }

  const { data, error } = await supabase
    .from("articles")
    .select("id, name, item_kind, unit_of_measure, default_waste_pct")
    .eq("pop_id", popId)
    .in("id", ids)
  if (error) return { success: false, error: error.message }

  const rows = (data ?? []) as Array<Record<string, unknown>>
  const referenceUnitCosts = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    ids,
  )
  return { success: true, data: mapIngredientOptions(rows, referenceUnitCosts) }
}
