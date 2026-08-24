import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import { applyInventoryFefoOrder, parseInventoryExpiresAt } from "../inventory/expiry.js"
import {
  ensurePopDefaultInventoryLocationId,
  sumInventoryOnHandForArticle,
} from "../inventory/locations.js"
import { parseQty, roundMoney } from "../inventory/qty.js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import { consumptionQuantity } from "../recipes/recipeCost.js"
import { parseIsoDate, type CreateManufacturingRunBody } from "./schema.js"

type MutateResult =
  | { success: true; id: string }
  | { success: false; error: string; status: 400 | 404 | 500 }

type FifoAllocationPlan = {
  layerId: string
  qty: number
  unitCost: number
  remainingBefore: number
}

function articleCostError(articleName: string): string {
  const label = articleName.trim() || "el insumo"
  return `Sin costo de referencia en «${label}»: registrá una compra o configurá costos de compra.`
}

async function resolveArticleReferenceUnitCost(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
): Promise<number> {
  const map = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    [articleId],
  )
  return map.get(articleId) ?? 0
}

async function planFefoConsume(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  locationId: string,
  needQty: number,
  articleName: string,
  allowNegative: boolean,
): Promise<
  | { ok: true; allocations: FifoAllocationPlan[]; leftoverQty: number; leftoverCost: number }
  | { ok: false; error: string }
> {
  const { data: layerRows, error } = await applyInventoryFefoOrder(
    supabase
      .from("inventory_cost_layers")
      .select("id, quantity_remaining, unit_cost, received_at, expires_at")
      .eq("pop_id", popId)
      .eq("article_id", articleId)
      .eq("location_id", locationId)
      .gt("quantity_remaining", 0),
  )
  if (error) {
    return { ok: false, error: error.message || "No se pudieron leer capas de costo." }
  }

  let need = needQty
  const allocations: FifoAllocationPlan[] = []
  for (const row of layerRows || []) {
    if (need <= 0) break
    const rem = parseQty(row.quantity_remaining)
    if (rem <= 0) continue
    const take = Math.min(need, rem)
    allocations.push({
      layerId: String(row.id),
      qty: take,
      unitCost: parseQty(row.unit_cost),
      remainingBefore: rem,
    })
    need = parseQty(need - take)
  }

  if (need <= 1e-9) {
    return { ok: true, allocations, leftoverQty: 0, leftoverCost: 0 }
  }

  const refCost = await resolveArticleReferenceUnitCost(supabase, popId, articleId)
  if (refCost <= 0 && !allowNegative) {
    return { ok: false, error: articleCostError(articleName) }
  }
  if (refCost <= 0 && allowNegative) {
    return { ok: true, allocations, leftoverQty: need, leftoverCost: 0 }
  }
  return {
    ok: true,
    allocations,
    leftoverQty: need,
    leftoverCost: roundMoney(need * refCost),
  }
}

export async function createManufacturingRun(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: CreateManufacturingRunBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const quantity = Number(input.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) {
    return {
      success: false,
      error: "La cantidad tiene que ser mayor que cero y hasta 10000.",
      status: 400,
    }
  }
  const producedAt = parseIsoDate(input.producedAt)
  if (!producedAt) {
    return { success: false, error: "Indicá el día de la producción.", status: 400 }
  }
  const expiresAt = parseInventoryExpiresAt(input.expiresAt ?? null)
  const notes = input.notes.trim()

  const { data: recipe, error: recipeErr } = await supabase
    .from("recipes")
    .select(
      "id, name, is_active, allow_negative_stock, output_article_id",
    )
    .eq("id", input.recipeId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (recipeErr || !recipe?.id) {
    return { success: false, error: "Receta no encontrada.", status: 404 }
  }
  if (!recipe.is_active) {
    return { success: false, error: "Esa receta está inactiva.", status: 400 }
  }

  const requestedOutputId =
    input.outputArticleId?.trim() ||
    (recipe.output_article_id ? String(recipe.output_article_id) : "")
  if (!requestedOutputId) {
    return {
      success: false,
      error: "Elegí el artículo que entra al depósito.",
      status: 400,
    }
  }

  const { data: outputArt, error: outErr } = await supabase
    .from("articles")
    .select("id, name, item_kind, is_active")
    .eq("id", requestedOutputId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (outErr || !outputArt?.id) {
    return {
      success: false,
      error: "El artículo que produce la receta no está en este punto.",
      status: 400,
    }
  }
  if (outputArt.is_active === false) {
    return {
      success: false,
      error: "El artículo producido está inactivo.",
      status: 400,
    }
  }
  const outputKind = String(outputArt.item_kind ?? "")
  if (outputKind !== "merchandise" && outputKind !== "raw_material") {
    return {
      success: false,
      error: "El artículo que produce tiene que ser mercadería o materia prima.",
      status: 400,
    }
  }

  const { data: ingRows, error: ingErr } = await supabase
    .from("recipe_ingredients")
    .select(
      `
      quantity,
      waste_pct,
      articles (
        id,
        name,
        default_waste_pct
      )
    `,
    )
    .eq("pop_id", popId)
    .eq("recipe_id", input.recipeId)
    .order("sort_order", { ascending: true })
  if (ingErr) {
    return { success: false, error: ingErr.message, status: 500 }
  }

  type ConsumeLine = {
    articleId: string
    articleName: string
    qty: number
  }
  const lines: ConsumeLine[] = []
  for (const row of ingRows ?? []) {
    const art = (row as Record<string, unknown>).articles as Record<
      string,
      unknown
    > | null
    if (!art?.id) continue
    const wastePct =
      row.waste_pct != null && Number.isFinite(Number(row.waste_pct))
        ? Number(row.waste_pct)
        : null
    const defaultWaste =
      art.default_waste_pct != null &&
      Number.isFinite(Number(art.default_waste_pct))
        ? Number(art.default_waste_pct)
        : null
    const qty = consumptionQuantity(
      parseQty(row.quantity),
      wastePct,
      defaultWaste,
      quantity,
    )
    if (qty <= 0) continue
    lines.push({
      articleId: String(art.id),
      articleName: String(art.name ?? ""),
      qty: parseQty(qty),
    })
  }
  if (lines.length === 0) {
    return {
      success: false,
      error: "La receta no tiene insumos para descontar.",
      status: 400,
    }
  }
  if (lines.some((line) => line.articleId === String(outputArt.id))) {
    return {
      success: false,
      error:
        "El artículo que produce no puede ser un insumo de la misma receta.",
      status: 400,
    }
  }

  const location = await ensurePopDefaultInventoryLocationId(supabase, popId)
  if (!location.success) {
    return { success: false, error: location.error, status: 400 }
  }
  const allowNegative = Boolean(recipe.allow_negative_stock)

  if (!allowNegative) {
    for (const line of lines) {
      const oh = await sumInventoryOnHandForArticle(
        supabase,
        popId,
        line.articleId,
        location.locationId,
      )
      if (!oh.success) {
        return { success: false, error: oh.error, status: 500 }
      }
      if (line.qty > oh.onHand + 1e-6) {
        return {
          success: false,
          error: `No hay stock suficiente de «${line.articleName}».`,
          status: 400,
        }
      }
    }
  }

  const plans: Array<
    ConsumeLine & {
      allocations: FifoAllocationPlan[]
      leftoverQty: number
      leftoverCost: number
      lineCost: number
    }
  > = []
  let totalCost = 0
  for (const line of lines) {
    const plan = await planFefoConsume(
      supabase,
      popId,
      line.articleId,
      location.locationId,
      line.qty,
      line.articleName,
      allowNegative,
    )
    if (!plan.ok) {
      return { success: false, error: plan.error, status: 400 }
    }
    const fromLayers = plan.allocations.reduce(
      (sum, alloc) => sum + roundMoney(alloc.qty * alloc.unitCost),
      0,
    )
    const lineCost = roundMoney(fromLayers + plan.leftoverCost)
    totalCost = roundMoney(totalCost + lineCost)
    plans.push({ ...line, ...plan, lineCost })
  }

  const unitCost = quantity > 0 ? roundMoney(totalCost / quantity) : 0
  const runId = randomUUID()
  const ops: AuditOp[] = []

  if (!recipe.output_article_id) {
    ops.push({
      op: "update",
      table: "recipes",
      id: String(recipe.id),
      row: { output_article_id: String(outputArt.id) },
    })
  }

  ops.push({
    op: "insert",
    table: "pop_manufacturing_runs",
    row: {
      id: runId,
      pop_id: popId,
      recipe_id: input.recipeId,
      output_article_id: String(outputArt.id),
      location_id: location.locationId,
      quantity,
      unit_cost: unitCost,
      total_cost: totalCost,
      expires_at: expiresAt,
      notes: notes || null,
      produced_at: producedAt,
      produced_by: userId,
    },
  })

  const consumeNote = `Fabricar — ${recipe.name}`
  for (const plan of plans) {
    const movementId = randomUUID()
    ops.push({
      op: "insert",
      table: "inventory_movements",
      row: {
        id: movementId,
        pop_id: popId,
        location_id: location.locationId,
        article_id: plan.articleId,
        quantity_delta: -plan.qty,
        movement_type: "manufacturing_consume",
        reference_type: "manufacturing_run",
        reference_id: runId,
        note: consumeNote,
        created_by: userId,
      },
    })
    for (const alloc of plan.allocations) {
      ops.push({
        op: "insert",
        table: "inventory_layer_allocations",
        row: {
          id: randomUUID(),
          pop_id: popId,
          layer_id: alloc.layerId,
          article_id: plan.articleId,
          inventory_movement_id: movementId,
          quantity: alloc.qty,
          unit_cost: alloc.unitCost,
        },
      })
    }
    for (const alloc of plan.allocations) {
      ops.push({
        op: "update",
        table: "inventory_cost_layers",
        id: alloc.layerId,
        row: { quantity_remaining: parseQty(alloc.remainingBefore - alloc.qty) },
      })
    }
  }

  const outputMovementId = randomUUID()
  ops.push({
    op: "insert",
    table: "inventory_movements",
    row: {
      id: outputMovementId,
      pop_id: popId,
      location_id: location.locationId,
      article_id: String(outputArt.id),
      quantity_delta: quantity,
      movement_type: "manufacturing_output",
      reference_type: "manufacturing_run",
      reference_id: runId,
      note: consumeNote,
      created_by: userId,
    },
  })
  ops.push({
    op: "insert",
    table: "inventory_cost_layers",
    row: {
      id: randomUUID(),
      pop_id: popId,
      location_id: location.locationId,
      article_id: String(outputArt.id),
      source_movement_id: outputMovementId,
      quantity_received: quantity,
      quantity_remaining: quantity,
      unit_cost: unitCost,
      expires_at: expiresAt,
    },
  })

  const applied = await applyWithAudit(supabase, {
    kind: "manufacturing.run",
    ctx: audit,
    popId,
    resourceId: runId,
    previous: null,
    next: {
      runId,
      recipeId: input.recipeId,
      quantity,
      unitCost,
      totalCost,
    },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, id: runId }
}
