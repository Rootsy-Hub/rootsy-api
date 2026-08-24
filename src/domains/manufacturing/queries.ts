import type { SupabaseClient } from "@supabase/supabase-js"
import { consumptionQuantity } from "../recipes/recipeCost.js"
import { ensurePopDefaultInventoryLocationId, sumInventoryOnHandForArticle } from "../inventory/locations.js"
import { parseQty } from "../inventory/qty.js"
import { parseIsoDate } from "./schema.js"
import type {
  ManufacturableRecipe,
  ManufacturingIngredientPreview,
  ManufacturingListData,
  ManufacturingRunRow,
} from "./schema.js"

const RUN_SELECT = `
  id,
  recipe_id,
  output_article_id,
  quantity,
  unit_cost,
  total_cost,
  expires_at,
  produced_at,
  produced_by,
  recipes!pop_manufacturing_runs_recipe_id_fkey ( id, name ),
  articles!pop_manufacturing_runs_output_article_id_fkey ( id, name, unit_of_measure )
`

function personName(row: { first_name?: string; last_name?: string } | null) {
  const first = String(row?.first_name ?? "").trim()
  const last = String(row?.last_name ?? "").trim()
  return `${first} ${last}`.trim()
}

function mapRunRow(
  row: Record<string, unknown>,
  namesByUserId: Map<string, string>,
): ManufacturingRunRow {
  const recipe = row.recipes as { id?: string; name?: string } | null
  const article = row.articles as {
    id?: string
    name?: string
    unit_of_measure?: string
  } | null
  const producedBy = row.produced_by ? String(row.produced_by) : ""
  return {
    id: String(row.id),
    producedAt: String(row.produced_at ?? "").slice(0, 10),
    recipeId: String(row.recipe_id ?? recipe?.id ?? ""),
    recipeName: String(recipe?.name ?? ""),
    outputArticleId: String(row.output_article_id ?? article?.id ?? ""),
    outputArticleName: String(article?.name ?? ""),
    outputUnitOfMeasure: String(article?.unit_of_measure ?? ""),
    quantity: parseQty(row.quantity),
    unitCost: Number(row.unit_cost ?? 0) || 0,
    totalCost: Number(row.total_cost ?? 0) || 0,
    expiresAt: row.expires_at ? String(row.expires_at).slice(0, 10) : null,
    producedByName: namesByUserId.get(producedBy) || "—",
  }
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

export async function listManufacturableRecipes(
  supabase: SupabaseClient,
  popId: string,
  input: { search?: string; limit?: number } = {},
): Promise<
  | { success: true; recipes: ManufacturableRecipe[] }
  | { success: false; error: string; status: 500 }
> {
  const search = input.search?.trim() ?? ""
  if (input.search != null && search.length < 1) {
    return { success: true, recipes: [] }
  }

  const location = await ensurePopDefaultInventoryLocationId(supabase, popId)
  const locationId = location.success ? location.locationId : null

  let recipeQuery = supabase
    .from("recipes")
    .select(
      `
      id,
      name,
      allow_negative_stock,
      output_article_id,
      articles!recipes_output_article_id_fkey ( id, name, unit_of_measure )
    `,
    )
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("name", { ascending: true })
  if (search) {
    recipeQuery = recipeQuery.ilike("name", `%${escapeIlikeToken(search)}%`)
  }
  if (input.limit && input.limit > 0) {
    recipeQuery = recipeQuery.limit(input.limit)
  }

  const { data: recipeRows, error: recipeErr } = await recipeQuery
  if (recipeErr) {
    return { success: false, error: recipeErr.message, status: 500 }
  }

  const recipes = recipeRows ?? []
  if (recipes.length === 0) {
    return { success: true, recipes: [] }
  }

  const recipeIds = recipes.map((row) => String(row.id))
  const { data: ingRows, error: ingErr } = await supabase
    .from("recipe_ingredients")
    .select(
      `
      recipe_id,
      quantity,
      waste_pct,
      articles (
        id,
        name,
        item_kind,
        unit_of_measure,
        default_waste_pct
      )
    `,
    )
    .eq("pop_id", popId)
    .in("recipe_id", recipeIds)
    .order("sort_order", { ascending: true })
  if (ingErr) {
    return { success: false, error: ingErr.message, status: 500 }
  }

  const onHandByArticle = new Map<string, number>()
  const articleIds = new Set<string>()
  for (const row of ingRows ?? []) {
    const art = (row as Record<string, unknown>).articles as
      | { id?: string }
      | null
    if (art?.id) articleIds.add(String(art.id))
  }
  if (locationId) {
    await Promise.all(
      [...articleIds].map(async (articleId) => {
        const oh = await sumInventoryOnHandForArticle(
          supabase,
          popId,
          articleId,
          locationId,
        )
        onHandByArticle.set(articleId, oh.success ? oh.onHand : 0)
      }),
    )
  }

  const ingredientsByRecipe = new Map<string, ManufacturingIngredientPreview[]>()
  for (const row of ingRows ?? []) {
    const art = (row as Record<string, unknown>).articles as Record<
      string,
      unknown
    > | null
    if (!art?.id) continue
    const articleId = String(art.id)
    const quantityPerUnit = parseQty(row.quantity)
    const wasteRaw = row.waste_pct
    const wastePct =
      wasteRaw != null && Number.isFinite(Number(wasteRaw))
        ? Number(wasteRaw)
        : null
    const defaultWaste =
      art.default_waste_pct != null && Number.isFinite(Number(art.default_waste_pct))
        ? Number(art.default_waste_pct)
        : null
    const rawKind = String(art.item_kind ?? "raw_material")
    const itemKind =
      rawKind === "merchandise" ||
      rawKind === "raw_material" ||
      rawKind === "supply"
        ? rawKind
        : "raw_material"
    const preview: ManufacturingIngredientPreview = {
      articleId,
      articleName: String(art.name ?? ""),
      itemKind,
      unitOfMeasure: String(art.unit_of_measure ?? ""),
      quantityPerUnit,
      wastePct,
      consumeQty: consumptionQuantity(
        quantityPerUnit,
        wastePct,
        defaultWaste,
        1,
      ),
      onHand: onHandByArticle.get(articleId) ?? 0,
    }
    const recipeId = String(row.recipe_id)
    const list = ingredientsByRecipe.get(recipeId) ?? []
    list.push(preview)
    ingredientsByRecipe.set(recipeId, list)
  }

  const result: ManufacturableRecipe[] = []
  for (const row of recipes) {
    const art = row.articles as {
      id?: string
      name?: string
      unit_of_measure?: string
    } | null
    const ingredients = ingredientsByRecipe.get(String(row.id)) ?? []
    if (ingredients.length === 0) continue
    result.push({
      id: String(row.id),
      name: String(row.name ?? ""),
      outputArticleId: String(row.output_article_id ?? art?.id ?? ""),
      outputArticleName: String(art?.name ?? ""),
      outputUnitOfMeasure: String(art?.unit_of_measure ?? ""),
      allowNegativeStock: Boolean(row.allow_negative_stock),
      ingredients,
    })
  }

  return { success: true, recipes: result }
}

export async function listManufacturingWorkspace(
  supabase: SupabaseClient,
  popId: string,
  input: { from: string; to: string },
  caps: { canCreate: boolean },
): Promise<
  | { success: true; data: ManufacturingListData }
  | { success: false; error: string; status: 500 }
> {
  const from = parseIsoDate(input.from)
  const to = parseIsoDate(input.to)

  let query = supabase
    .from("pop_manufacturing_runs")
    .select(RUN_SELECT)
    .eq("pop_id", popId)
    .order("produced_at", { ascending: false })
    .order("created_at", { ascending: false })
  if (from) query = query.gte("produced_at", from)
  if (to) query = query.lte("produced_at", to)

  const runsRes = await query
  if (runsRes.error) {
    return { success: false, error: runsRes.error.message, status: 500 }
  }

  const namesByUserId = new Map<string, string>()
  const userIds = [
    ...new Set(
      (runsRes.data ?? [])
        .map((row) => (row.produced_by ? String(row.produced_by) : ""))
        .filter(Boolean),
    ),
  ]
  if (userIds.length > 0) {
    const { data: userRows } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .in("id", userIds)
    for (const user of userRows ?? []) {
      const name = personName(user)
      if (name) namesByUserId.set(String(user.id), name)
    }
  }

  return {
    success: true,
    data: {
      runs: (runsRes.data ?? []).map((row) =>
        mapRunRow(row as Record<string, unknown>, namesByUserId),
      ),
      recipes: [],
      canCreate: caps.canCreate,
    },
  }
}
