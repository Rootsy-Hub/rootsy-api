import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveArticleReferenceUnitCostsByArticleId } from "./articleReferenceCost.js"
import { computeRecipeCostPrice } from "./recipeCost.js"
import type {
  IngredientInput,
  ListPriceAmountInput,
  UpsertRecipeBody,
} from "./schema.js"

type MutateResult =
  | { success: true; id?: string }
  | { success: false; error: string; status: 400 | 403 | 404 | 409 | 500 }

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

function parseOptionalPct(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round(n * 100) / 100
}

function parseQty(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function recipeDeleteConfirmPhrase(recipeName: string): string {
  const name = recipeName.trim() || "esta receta"
  return `Eliminar ${name}`
}

function validateRecipeInput(
  input: UpsertRecipeBody,
): { ok: true } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) return { ok: false, error: "Indicá el nombre de la receta." }
  if (name.length > 200) {
    return { ok: false, error: "El nombre no puede superar 200 caracteres." }
  }
  const categoryId = input.categoryId.trim()
  if (!categoryId) return { ok: false, error: "Elegí una categoría." }
  const salePrice = Number(input.salePrice)
  if (!Number.isFinite(salePrice) || salePrice < 0) {
    return { ok: false, error: "Precio de venta inválido." }
  }
  const iva = Number(input.iva)
  if (!Number.isFinite(iva) || iva < 0 || iva > 100) {
    return { ok: false, error: "IVA inválido." }
  }
  if (!input.ingredients?.length) {
    return { ok: false, error: "Agregá al menos un ingrediente." }
  }
  const seen = new Set<string>()
  for (const line of input.ingredients) {
    const articleId = line.articleId?.trim()
    if (!articleId) return { ok: false, error: "Ingrediente inválido." }
    if (seen.has(articleId)) {
      return { ok: false, error: "No podés repetir el mismo ingrediente." }
    }
    seen.add(articleId)
    if (parseQty(line.quantity) == null) {
      return { ok: false, error: "Cantidad de ingrediente inválida." }
    }
    if (line.wastePct != null && parseOptionalPct(line.wastePct) == null) {
      return { ok: false, error: "Merma inválida en un ingrediente." }
    }
  }
  return { ok: true }
}

async function loadIngredientArticles(
  supabase: SupabaseClient,
  popId: string,
  ingredients: IngredientInput[],
): Promise<
  | {
      ok: true
      rows: {
        articleId: string
        quantity: number
        wastePct: number | null
        costPrice: number
        defaultWastePct: number | null
      }[]
    }
  | { ok: false; error: string }
> {
  const ids = ingredients.map((i) => i.articleId.trim())
  const { data, error } = await supabase
    .from("articles")
    .select("id, item_kind, default_waste_pct, is_active")
    .eq("pop_id", popId)
    .in("id", ids)
  if (error) {
    return { ok: false, error: error.message || "No se pudieron validar ingredientes." }
  }
  const referenceUnitCosts = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    ids,
  )
  const byId = new Map(
    (data ?? []).map((r) => [String(r.id), r as Record<string, unknown>]),
  )
  const rows: {
    articleId: string
    quantity: number
    wastePct: number | null
    costPrice: number
    defaultWastePct: number | null
  }[] = []

  for (const line of ingredients) {
    const row = byId.get(line.articleId.trim())
    if (!row || !row.is_active) {
      return { ok: false, error: "Uno de los ingredientes ya no está disponible." }
    }
    const rawKind = String(row.item_kind ?? "")
    if (rawKind !== "raw_material" && rawKind !== "supply") {
      return {
        ok: false,
        error: "Solo podés usar materias primas o insumos en una receta.",
      }
    }
    const qty = parseQty(line.quantity)
    if (qty == null) {
      return { ok: false, error: "Cantidad de ingrediente inválida." }
    }
    rows.push({
      articleId: line.articleId.trim(),
      quantity: qty,
      wastePct: line.wastePct == null ? null : parseOptionalPct(line.wastePct),
      costPrice: referenceUnitCosts.get(line.articleId.trim()) ?? 0,
      defaultWastePct:
        row.default_waste_pct != null &&
        Number.isFinite(Number(row.default_waste_pct))
          ? Number(row.default_waste_pct)
          : null,
    })
  }
  return { ok: true, rows }
}

async function syncRecipeIngredients(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
  ingredients: IngredientInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error: delErr } = await supabase
    .from("recipe_ingredients")
    .delete()
    .eq("recipe_id", recipeId)
    .eq("pop_id", popId)
  if (delErr) {
    return {
      ok: false,
      error: delErr.message || "No se pudieron actualizar ingredientes.",
    }
  }
  if (ingredients.length === 0) return { ok: true }

  const { error: insErr } = await supabase.from("recipe_ingredients").insert(
    ingredients.map((line, index) => ({
      recipe_id: recipeId,
      pop_id: popId,
      article_id: line.articleId.trim(),
      quantity: parseQty(line.quantity),
      waste_pct: line.wastePct == null ? null : parseOptionalPct(line.wastePct),
      sort_order: index,
    })),
  )
  if (insErr) {
    return {
      ok: false,
      error: insErr.message || "No se pudieron guardar ingredientes.",
    }
  }
  return { ok: true }
}

async function syncRecipePriceLists(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
  inputs: ListPriceAmountInput[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: extraLists, error: listsError } = await supabase
    .from("price_lists")
    .select("id")
    .eq("pop_id", popId)
    .eq("is_default", false)
  if (listsError) return { ok: false, error: listsError.message }

  const extraIds = new Set((extraLists ?? []).map((row) => String(row.id)))
  const wanted = inputs.filter((row) => extraIds.has(row.listId))

  for (const row of wanted) {
    if (row.amount == null) {
      const { error } = await supabase
        .from("price_list_items")
        .delete()
        .eq("pop_id", popId)
        .eq("price_list_id", row.listId)
        .eq("item_kind", "recipe")
        .eq("item_id", recipeId)
      if (error) return { ok: false, error: error.message }
      continue
    }

    const { error } = await supabase.from("price_list_items").upsert(
      {
        pop_id: popId,
        price_list_id: row.listId,
        item_kind: "recipe",
        item_id: recipeId,
        amount: row.amount,
      },
      { onConflict: "price_list_id,item_kind,item_id" },
    )
    if (error) return { ok: false, error: error.message }
  }

  return { ok: true }
}

export async function createRecipe(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertRecipeBody,
): Promise<MutateResult> {
  const validation = validateRecipeInput(input)
  if (!validation.ok) return { success: false, error: validation.error, status: 400 }

  const { data: catRow } = await supabase
    .from("recipe_categories")
    .select("id")
    .eq("id", input.categoryId.trim())
    .eq("pop_id", popId)
    .eq("is_active", true)
    .maybeSingle()
  if (!catRow?.id) {
    return { success: false, error: "Categoría inválida.", status: 400 }
  }

  const loaded = await loadIngredientArticles(supabase, popId, input.ingredients)
  if (!loaded.ok) return { success: false, error: loaded.error, status: 400 }

  const costPrice = computeRecipeCostPrice(
    loaded.rows.map((r) => ({
      quantity: r.quantity,
      wastePct: r.wastePct,
      articleCostPrice: r.costPrice,
      articleDefaultWastePct: r.defaultWastePct,
    })),
  )

  const imageUrl = input.imageUrl.trim()
  const { data: created, error } = await supabase
    .from("recipes")
    .insert({
      pop_id: popId,
      category_id: input.categoryId.trim(),
      name: input.name.trim(),
      description: input.description.trim(),
      sale_price: roundMoney(Number(input.salePrice)),
      cost_price: costPrice,
      iva: Number(input.iva),
      image_url: imageUrl ? imageUrl : null,
      is_active: input.isActive,
      allow_negative_stock: Boolean(input.allowNegativeStock),
    })
    .select("id")
    .single()

  if (error || !created?.id) {
    return {
      success: false,
      error: error?.message || "No se pudo crear la receta.",
      status: 500,
    }
  }

  const recipeId = String(created.id)
  const sync = await syncRecipeIngredients(
    supabase,
    popId,
    recipeId,
    input.ingredients,
  )
  if (!sync.ok) {
    await supabase.from("recipes").delete().eq("id", recipeId).eq("pop_id", popId)
    return { success: false, error: sync.error, status: 400 }
  }

  const syncLists = await syncRecipePriceLists(
    supabase,
    popId,
    recipeId,
    input.listPrices ?? [],
  )
  if (!syncLists.ok) {
    await supabase.from("recipes").delete().eq("id", recipeId).eq("pop_id", popId)
    return { success: false, error: syncLists.error, status: 400 }
  }

  return { success: true, id: recipeId }
}

export async function updateRecipe(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
  input: UpsertRecipeBody,
): Promise<MutateResult> {
  const validation = validateRecipeInput(input)
  if (!validation.ok) return { success: false, error: validation.error, status: 400 }

  const { data: existing } = await supabase
    .from("recipes")
    .select("id")
    .eq("id", recipeId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (!existing?.id) {
    return { success: false, error: "Receta no encontrada.", status: 404 }
  }

  const { data: catRow } = await supabase
    .from("recipe_categories")
    .select("id")
    .eq("id", input.categoryId.trim())
    .eq("pop_id", popId)
    .eq("is_active", true)
    .maybeSingle()
  if (!catRow?.id) {
    return { success: false, error: "Categoría inválida.", status: 400 }
  }

  const loaded = await loadIngredientArticles(supabase, popId, input.ingredients)
  if (!loaded.ok) return { success: false, error: loaded.error, status: 400 }

  const costPrice = computeRecipeCostPrice(
    loaded.rows.map((r) => ({
      quantity: r.quantity,
      wastePct: r.wastePct,
      articleCostPrice: r.costPrice,
      articleDefaultWastePct: r.defaultWastePct,
    })),
  )

  const imageUrl = input.imageUrl.trim()
  const { error } = await supabase
    .from("recipes")
    .update({
      category_id: input.categoryId.trim(),
      name: input.name.trim(),
      description: input.description.trim(),
      sale_price: roundMoney(Number(input.salePrice)),
      cost_price: costPrice,
      iva: Number(input.iva),
      image_url: imageUrl ? imageUrl : null,
      is_active: input.isActive,
      allow_negative_stock: Boolean(input.allowNegativeStock),
    })
    .eq("id", recipeId)
    .eq("pop_id", popId)

  if (error) {
    return { success: false, error: error.message, status: 500 }
  }

  const sync = await syncRecipeIngredients(
    supabase,
    popId,
    recipeId,
    input.ingredients,
  )
  if (!sync.ok) return { success: false, error: sync.error, status: 400 }

  const syncLists = await syncRecipePriceLists(
    supabase,
    popId,
    recipeId,
    input.listPrices ?? [],
  )
  if (!syncLists.ok) return { success: false, error: syncLists.error, status: 400 }

  return { success: true }
}

export async function deleteRecipe(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
  confirmationTyped: string,
): Promise<MutateResult> {
  const { data: recipe, error: fetchError } = await supabase
    .from("recipes")
    .select("name")
    .eq("id", recipeId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return {
      success: false,
      error: fetchError.message || "No se encontró la receta.",
      status: 500,
    }
  }
  if (!recipe) {
    return { success: false, error: "No se encontró la receta.", status: 404 }
  }

  const expectedPhrase = recipeDeleteConfirmPhrase(String(recipe.name ?? ""))
  if (confirmationTyped.trim() !== expectedPhrase) {
    return {
      success: false,
      error: `Escribí (${expectedPhrase}) para confirmar el borrado.`,
      status: 400,
    }
  }

  const { error } = await supabase
    .from("recipes")
    .delete()
    .eq("id", recipeId)
    .eq("pop_id", popId)
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}
