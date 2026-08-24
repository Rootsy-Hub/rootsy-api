import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  auditedDelete,
} from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import { resolveArticleReferenceUnitCostsByArticleId } from "./articleReferenceCost.js"
import { computeRecipeCostPrice } from "./recipeCost.js"
import { mergePatch } from "../../lib/patchBody.js"
import { getRecipe } from "./queries.js"
import type {
  IngredientInput,
  ListPriceAmountInput,
  PatchRecipeBody,
  RecipeDetail,
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

const RECIPE_OUTPUT_KINDS = new Set(["merchandise", "raw_material"])

async function resolveOutputArticle(
  supabase: SupabaseClient,
  popId: string,
  outputArticleId: string | null | undefined,
  ingredientIds: string[],
): Promise<
  { ok: true; articleId: string | null } | { ok: false; error: string }
> {
  const id = outputArticleId?.trim() ?? ""
  if (!id) return { ok: true, articleId: null }
  if (ingredientIds.includes(id)) {
    return {
      ok: false,
      error:
        "El artículo que produce no puede ser un ingrediente de la misma receta.",
    }
  }
  const { data, error } = await supabase
    .from("articles")
    .select("id, item_kind, is_active")
    .eq("id", id)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error || !data?.id) {
    return { ok: false, error: "Artículo de producción no encontrado." }
  }
  if (data.is_active === false) {
    return { ok: false, error: "El artículo de producción está inactivo." }
  }
  const kind = String(data.item_kind ?? "")
  if (!RECIPE_OUTPUT_KINDS.has(kind)) {
    return {
      ok: false,
      error: "El artículo que produce tiene que ser mercadería o materia prima.",
    }
  }
  return { ok: true, articleId: String(data.id) }
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

function ingredientReplaceOps(
  popId: string,
  recipeId: string,
  ingredients: IngredientInput[],
  existingIds: string[],
): AuditOp[] {
  const ops: AuditOp[] = existingIds.map((id) => ({
    op: "delete",
    table: "recipe_ingredients",
    id,
  }))
  for (const [index, line] of ingredients.entries()) {
    ops.push({
      op: "insert",
      table: "recipe_ingredients",
      row: {
        id: randomUUID(),
        recipe_id: recipeId,
        pop_id: popId,
        article_id: line.articleId.trim(),
        quantity: parseQty(line.quantity),
        waste_pct: line.wastePct == null ? null : parseOptionalPct(line.wastePct),
        sort_order: index,
      },
    })
  }
  return ops
}

async function buildRecipeListPriceOps(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
  inputs: ListPriceAmountInput[],
): Promise<{ ok: true; ops: AuditOp[] } | { ok: false; error: string }> {
  const { data: extraLists, error: listsError } = await supabase
    .from("price_lists")
    .select("id")
    .eq("pop_id", popId)
    .eq("is_default", false)
  if (listsError) return { ok: false, error: listsError.message }
  const extraIds = new Set((extraLists ?? []).map((row) => String(row.id)))
  const wanted = inputs.filter((row) => extraIds.has(row.listId))
  const ops: AuditOp[] = []
  for (const row of wanted) {
    const { data: existing } = await supabase
      .from("price_list_items")
      .select("id")
      .eq("pop_id", popId)
      .eq("price_list_id", row.listId)
      .eq("item_kind", "recipe")
      .eq("item_id", recipeId)
      .maybeSingle()
    if (row.amount == null) {
      if (existing?.id) {
        ops.push({ op: "delete", table: "price_list_items", id: String(existing.id) })
      }
      continue
    }
    if (existing?.id) {
      ops.push({
        op: "update",
        table: "price_list_items",
        id: String(existing.id),
        row: { amount: row.amount },
      })
    } else {
      ops.push({
        op: "insert",
        table: "price_list_items",
        row: {
          id: randomUUID(),
          pop_id: popId,
          price_list_id: row.listId,
          item_kind: "recipe",
          item_id: recipeId,
          amount: row.amount,
        },
      })
    }
  }
  return { ok: true, ops }
}

export async function createRecipe(
  supabase: SupabaseClient,
  popId: string,
  input: UpsertRecipeBody,
  audit: MutationAuditCtx,
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

  const output = await resolveOutputArticle(
    supabase,
    popId,
    input.outputArticleId,
    input.ingredients.map((line) => line.articleId.trim()),
  )
  if (!output.ok) return { success: false, error: output.error, status: 400 }

  const costPrice = computeRecipeCostPrice(
    loaded.rows.map((r) => ({
      quantity: r.quantity,
      wastePct: r.wastePct,
      articleCostPrice: r.costPrice,
      articleDefaultWastePct: r.defaultWastePct,
    })),
  )

  const imageUrl = input.imageUrl.trim()
  const recipeId = randomUUID()
  const recipeRow = {
    id: recipeId,
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
    output_article_id: output.articleId,
  }

  const ops: AuditOp[] = [{ op: "insert", table: "recipes", row: recipeRow }]
  ops.push(...ingredientReplaceOps(popId, recipeId, input.ingredients, []))

  const listOps = await buildRecipeListPriceOps(
    supabase,
    popId,
    recipeId,
    input.listPrices ?? [],
  )
  if (!listOps.ok) return { success: false, error: listOps.error, status: 400 }
  ops.push(...listOps.ops)

  const applied = await applyWithAudit(supabase, {
    kind: "recipes.create",
    ctx: audit,
    popId,
    resourceId: recipeId,
    previous: null,
    next: recipeRow,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, id: recipeId }
}

function recipeToUpsertBody(row: RecipeDetail): UpsertRecipeBody {
  return {
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl ?? "",
    categoryId: row.categoryId ?? "",
    salePrice: row.salePrice,
    iva: row.iva,
    isActive: row.isActive,
    allowNegativeStock: row.allowNegativeStock,
    outputArticleId: row.outputArticleId,
    ingredients: row.ingredients.map((line) => ({
      articleId: line.articleId,
      quantity: line.quantity,
      wastePct: line.wastePct,
    })),
    listPrices: row.listPrices.map((line) => ({
      listId: line.listId,
      amount: line.amount,
    })),
  }
}

export async function updateRecipe(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
  patch: PatchRecipeBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const current = await getRecipe(supabase, popId, recipeId)
  if (!current.success) {
    return {
      success: false,
      error: current.error,
      status: current.status,
    }
  }
  const input = mergePatch(recipeToUpsertBody(current.data), patch)

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

  const output = await resolveOutputArticle(
    supabase,
    popId,
    input.outputArticleId,
    input.ingredients.map((line) => line.articleId.trim()),
  )
  if (!output.ok) return { success: false, error: output.error, status: 400 }

  const costPrice = computeRecipeCostPrice(
    loaded.rows.map((r) => ({
      quantity: r.quantity,
      wastePct: r.wastePct,
      articleCostPrice: r.costPrice,
      articleDefaultWastePct: r.defaultWastePct,
    })),
  )

  const imageUrl = input.imageUrl.trim()
  const updateRow = {
    category_id: input.categoryId.trim(),
    name: input.name.trim(),
    description: input.description.trim(),
    sale_price: roundMoney(Number(input.salePrice)),
    cost_price: costPrice,
    iva: Number(input.iva),
    image_url: imageUrl ? imageUrl : null,
    is_active: input.isActive,
    allow_negative_stock: Boolean(input.allowNegativeStock),
    output_article_id: output.articleId,
  }

  const ops: AuditOp[] = [
    { op: "update", table: "recipes", id: recipeId, row: updateRow },
  ]

  if (patch.ingredients !== undefined) {
    ops.push(
      ...ingredientReplaceOps(
        popId,
        recipeId,
        patch.ingredients,
        current.data.ingredients.map((line) => line.id),
      ),
    )
  }

  if (patch.listPrices !== undefined) {
    const listOps = await buildRecipeListPriceOps(
      supabase,
      popId,
      recipeId,
      patch.listPrices,
    )
    if (!listOps.ok) return { success: false, error: listOps.error, status: 400 }
    ops.push(...listOps.ops)
  }

  const applied = await applyWithAudit(supabase, {
    kind: "recipes.patch",
    ctx: audit,
    popId,
    resourceId: recipeId,
    previous: current.data,
    next: { ...current.data, ...input },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function deleteRecipe(
  supabase: SupabaseClient,
  popId: string,
  recipeId: string,
  confirmationTyped: string,
  audit: MutationAuditCtx,
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

  const applied = await auditedDelete(supabase, {
    kind: "recipes.delete",
    table: "recipes",
    id: recipeId,
    ctx: audit,
    popId,
    previous: recipe,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status,
    }
  }
  return { success: true }
}
