import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuditOp } from "../../audit/types.js"
import { applyInventoryFefoOrder } from "../inventory/expiry.js"
import {
  getPopSellableInventoryLocationId,
  sumInventoryOnHandForArticle,
} from "../inventory/locations.js"
import { parseQty, roundMoney } from "../inventory/qty.js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"

export type StockDeductionNeed = {
  articleId: string
  qty: number
  articleName: string
  sources: string[]
  allowNegativeQty: number
}

type BuiltStockLine = {
  lineKind: "article" | "recipe" | "promotion"
  articleId: string | null
  recipeId: string | null
  name: string
  qty: number
  promotionComponents?: Array<{
    kind: "article" | "recipe"
    articleId: string | null
    recipeId: string | null
    quantity: number
    name: string
  }>
}

function consumptionQuantity(
  quantity: number,
  wastePct: number | null | undefined,
  articleDefaultWastePct: number | null | undefined,
  unitsSold: number,
): number {
  const waste =
    wastePct != null && Number.isFinite(wastePct)
      ? Math.max(0, Math.min(100, wastePct))
      : articleDefaultWastePct != null && Number.isFinite(articleDefaultWastePct)
        ? Math.max(0, Math.min(100, articleDefaultWastePct))
        : 0
  return quantity * unitsSold * (1 + waste / 100)
}

function addNeed(
  byArticle: Map<
    string,
    {
      qty: number
      allowNegativeQty: number
      articleName: string
      sources: Set<string>
    }
  >,
  articleId: string,
  qty: number,
  articleName: string,
  sourceName: string | null,
  allowNegative = false,
) {
  if (qty <= 0) return
  const name = articleName.trim() || "Insumo"
  const prev = byArticle.get(articleId) ?? {
    qty: 0,
    allowNegativeQty: 0,
    articleName: name,
    sources: new Set<string>(),
  }
  prev.qty += qty
  if (allowNegative) prev.allowNegativeQty += qty
  if (name) prev.articleName = name
  const source = sourceName?.trim()
  if (source) prev.sources.add(source)
  byArticle.set(articleId, prev)
}

function formatShortage(shortages: Array<{
  articleName: string
  sources: string[]
  needed: number
  onHand: number
}>): string {
  if (shortages.length === 1) {
    const item = shortages[0]!
    return `No hay stock suficiente de «${item.articleName}». Hace falta ${item.needed} y hay ${item.onHand}.`
  }
  return `Hay ${shortages.length} artículos sin stock suficiente.`
}

export async function collectStockDeductionNeeds(
  supabase: SupabaseClient,
  popId: string,
  built: BuiltStockLine[],
): Promise<
  | { success: true; needs: StockDeductionNeed[] }
  | { success: false; error: string; status: 400 | 500 }
> {
  const byArticle = new Map<
    string,
    {
      qty: number
      allowNegativeQty: number
      articleName: string
      sources: Set<string>
    }
  >()
  const recipeIds = new Set<string>()
  for (const line of built) {
    if (line.lineKind === "recipe" && line.recipeId) recipeIds.add(line.recipeId)
    if (line.lineKind === "promotion") {
      for (const comp of line.promotionComponents ?? []) {
        if (comp.kind === "recipe" && comp.recipeId) recipeIds.add(comp.recipeId)
      }
    }
  }

  const recipeAllowNegative = new Map<string, boolean>()
  const ingredientsByRecipe = new Map<
    string,
    Array<{
      quantity: number
      wastePct: number | null
      articleId: string
      articleName: string
      defaultWastePct: number | null
    }>
  >()

  if (recipeIds.size > 0) {
    const ids = [...recipeIds]
    const { data: recipeFlagRows, error: recipeFlagErr } = await supabase
      .from("recipes")
      .select("id, allow_negative_stock")
      .eq("pop_id", popId)
      .in("id", ids)
    if (recipeFlagErr) {
      return {
        success: false,
        error:
          recipeFlagErr.message ||
          "No se pudo leer si las recetas permiten stock negativo.",
        status: 500,
      }
    }
    for (const row of recipeFlagRows ?? []) {
      recipeAllowNegative.set(String(row.id), Boolean(row.allow_negative_stock))
    }

    const { data: ingRows, error: ingErr } = await supabase
      .from("recipe_ingredients")
      .select(
        `
        recipe_id,
        quantity,
        waste_pct,
        articles ( id, name, default_waste_pct )
      `,
      )
      .eq("pop_id", popId)
      .in("recipe_id", ids)
      .order("sort_order", { ascending: true })
    if (ingErr) {
      return {
        success: false,
        error:
          ingErr.message || "No se pudieron leer los ingredientes de la receta.",
        status: 500,
      }
    }
    for (const row of ingRows ?? []) {
      const recipeId = String(row.recipe_id ?? "")
      const art = row.articles as {
        id?: string
        name?: string
        default_waste_pct?: number | null
      } | null
      if (!recipeId || !art?.id) continue
      const list = ingredientsByRecipe.get(recipeId) ?? []
      list.push({
        quantity: Number(row.quantity ?? 0) || 0,
        wastePct: row.waste_pct != null ? Number(row.waste_pct) : null,
        articleId: String(art.id),
        articleName: String(art.name ?? "Ingrediente"),
        defaultWastePct:
          art.default_waste_pct != null ? Number(art.default_waste_pct) : null,
      })
      ingredientsByRecipe.set(recipeId, list)
    }
  }

  const applyRecipe = (
    recipeId: string,
    units: number,
    sourceName: string,
  ) => {
    const ings = ingredientsByRecipe.get(recipeId) ?? []
    const allowNeg = recipeAllowNegative.get(recipeId) === true
    for (const ing of ings) {
      addNeed(
        byArticle,
        ing.articleId,
        consumptionQuantity(ing.quantity, ing.wastePct, ing.defaultWastePct, units),
        ing.articleName,
        sourceName,
        allowNeg,
      )
    }
  }

  for (const line of built) {
    if (line.lineKind === "promotion" && line.promotionComponents?.length) {
      for (const comp of line.promotionComponents) {
        const compQty = parseQty(comp.quantity)
        if (comp.kind === "article" && comp.articleId) {
          addNeed(byArticle, comp.articleId, compQty, comp.name, line.name)
        } else if (comp.kind === "recipe" && comp.recipeId) {
          applyRecipe(comp.recipeId, compQty, line.name)
        }
      }
      continue
    }
    if (line.lineKind === "article" && line.articleId) {
      addNeed(byArticle, line.articleId, line.qty, line.name, null)
      continue
    }
    if (line.lineKind === "recipe" && line.recipeId) {
      applyRecipe(line.recipeId, line.qty, line.name)
    }
  }

  return {
    success: true,
    needs: [...byArticle.entries()].map(([articleId, entry]) => ({
      articleId,
      qty: parseQty(entry.qty),
      allowNegativeQty: parseQty(entry.allowNegativeQty),
      articleName: entry.articleName,
      sources: [...entry.sources],
    })),
  }
}

export async function assertStockForSaleNeeds(
  supabase: SupabaseClient,
  popId: string,
  locationId: string,
  needs: StockDeductionNeed[],
): Promise<{ success: true } | { success: false; error: string; status: 400 | 500 }> {
  if (needs.length === 0) return { success: true }
  const articleIds = [...new Set(needs.map((need) => need.articleId))]
  const { data: flagRows, error: flagErr } = await supabase
    .from("articles")
    .select("id, name, allow_negative_stock")
    .eq("pop_id", popId)
    .in("id", articleIds)
  if (flagErr) {
    return {
      success: false,
      error:
        flagErr.message ||
        "No se pudo leer si los artículos permiten stock negativo.",
      status: 500,
    }
  }
  const articleById = new Map<string, { allowNegative: boolean; name: string }>()
  for (const row of flagRows ?? []) {
    articleById.set(String(row.id), {
      allowNegative: Boolean(row.allow_negative_stock),
      name: String(row.name ?? "").trim(),
    })
  }
  const shortages: Array<{
    articleName: string
    sources: string[]
    needed: number
    onHand: number
  }> = []
  for (const need of needs) {
    const article = articleById.get(need.articleId)
    if (article?.allowNegative) continue
    const gatedQty = Math.max(0, need.qty - need.allowNegativeQty)
    if (gatedQty <= 1e-6) continue
    const oh = await sumInventoryOnHandForArticle(
      supabase,
      popId,
      need.articleId,
      locationId,
    )
    if (!oh.success) {
      return { success: false, error: oh.error, status: 500 }
    }
    if (gatedQty > oh.onHand + 1e-6) {
      shortages.push({
        articleName: need.articleName || article?.name || "Insumo",
        sources: need.sources,
        needed: gatedQty,
        onHand: Math.max(0, oh.onHand),
      })
    }
  }
  if (shortages.length > 0) {
    return { success: false, error: formatShortage(shortages), status: 400 }
  }
  return { success: true }
}

type FifoPlan = {
  layerId: string
  qty: number
  unitCost: number
  remainingBefore: number
}

export async function buildSaleStockOps(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  saleId: string,
  needs: StockDeductionNeed[],
): Promise<
  | { success: true; ops: AuditOp[]; cogsTotal: number; locationId: string }
  | { success: false; error: string; status: 400 | 500 }
> {
  const location = await getPopSellableInventoryLocationId(supabase, popId)
  if (!location.success) {
    return { success: false, error: location.error, status: 400 }
  }
  const stockGuard = await assertStockForSaleNeeds(
    supabase,
    popId,
    location.locationId,
    needs,
  )
  if (!stockGuard.success) return stockGuard

  const costs = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    needs.map((need) => need.articleId),
  )

  const ops: AuditOp[] = []
  let cogsTotal = 0

  for (const need of needs) {
    const qtyAbs = need.qty
    const delta = -qtyAbs
    const articleName = need.articleName
    const articleCostRef = roundMoney(costs.get(need.articleId) ?? 0)
    const { data: layerRows, error: lrErr } = await applyInventoryFefoOrder(
      supabase
        .from("inventory_cost_layers")
        .select("id, quantity_remaining, unit_cost, received_at, expires_at")
        .eq("pop_id", popId)
        .eq("article_id", need.articleId)
        .eq("location_id", location.locationId)
        .gt("quantity_remaining", 0),
    )
    if (lrErr) {
      return {
        success: false,
        error: lrErr.message || "No se pudieron leer capas de costo.",
        status: 500,
      }
    }
    const layers = layerRows || []
    let amount = 0
    const fifoAllocations: FifoPlan[] = []
    if (layers.length === 0) {
      if (articleCostRef <= 0) {
        return {
          success: false,
          error: `Sin costo de referencia en «${articleName}»: registrá una compra o configurá costos de compra.`,
          status: 400,
        }
      }
      amount = roundMoney(qtyAbs * articleCostRef)
    } else {
      let remaining = qtyAbs
      let totalCost = 0
      for (const row of layers) {
        if (remaining <= 0) break
        const rem = parseQty(row.quantity_remaining)
        if (rem <= 0) continue
        const take = Math.min(remaining, rem)
        const uc = parseQty(row.unit_cost)
        totalCost += roundMoney(take * uc)
        fifoAllocations.push({
          layerId: String(row.id),
          qty: take,
          unitCost: uc,
          remainingBefore: rem,
        })
        remaining = parseQty(remaining - take)
      }
      if (remaining > 0) {
        if (articleCostRef <= 0) {
          return {
            success: false,
            error: `Sin costo de referencia en «${articleName}»: registrá una compra o configurá costos de compra.`,
            status: 400,
          }
        }
        totalCost += roundMoney(remaining * articleCostRef)
      }
      amount = roundMoney(totalCost)
    }
    if (amount <= 0) {
      return {
        success: false,
        error: `No se pudo valorar el costo de «${articleName}».`,
        status: 400,
      }
    }
    cogsTotal = roundMoney(cogsTotal + amount)
    const movementId = randomUUID()
    ops.push({
      op: "insert",
      table: "inventory_movements",
      row: {
        id: movementId,
        pop_id: popId,
        location_id: location.locationId,
        article_id: need.articleId,
        quantity_delta: delta,
        movement_type: "sale",
        sale_id: saleId,
        note: `Venta — ${articleName}`,
        created_by: userId,
      },
    })
    for (const a of fifoAllocations) {
      ops.push({
        op: "insert",
        table: "inventory_layer_allocations",
        row: {
          id: randomUUID(),
          pop_id: popId,
          layer_id: a.layerId,
          article_id: need.articleId,
          inventory_movement_id: movementId,
          quantity: a.qty,
          unit_cost: a.unitCost,
        },
      })
      ops.push({
        op: "update",
        table: "inventory_cost_layers",
        id: a.layerId,
        row: { quantity_remaining: parseQty(a.remainingBefore - a.qty) },
      })
    }
  }

  return { success: true, ops, cogsTotal, locationId: location.locationId }
}

export { getPopSellableInventoryLocationId }
