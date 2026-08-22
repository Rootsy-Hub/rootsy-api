import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import {
  CHART_GASTO_MERMA_CODES,
  CHART_INGRESO_AJUSTE_CODES,
  CHART_MERCADERIAS_CODES,
} from "./chart.js"
import { applyInventoryFefoOrder, parseInventoryExpiresAt } from "./expiry.js"
import {
  ensurePopDefaultInventoryLocationId,
  resolvePopInventoryLocationId,
  sumInventoryOnHandForArticle,
} from "./locations.js"
import { parseQty, roundMoney } from "./qty.js"
import { listInventoryArticleRows } from "./queries.js"
import type { ApplyMinStockBody, CreateAdjustmentBody } from "./schema.js"
import { entryDateIsoInTimezone, timezoneForPopLedger } from "./timezone.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

type ApplyResult =
  | { success: true; data: { applied: number } }
  | { success: false; error: string; status: 400 | 403 | 500 }

function articleReferenceCostError(articleName: string): string {
  const label = articleName.trim() || "el artículo"
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

async function resolveAccountId(
  supabase: SupabaseClient,
  popId: string,
  codes: readonly string[],
): Promise<string | null> {
  for (const code of codes) {
    const { data: row } = await supabase
      .from("accounting_chart_of_accounts")
      .select("id")
      .eq("pop_id", popId)
      .eq("code", code)
      .maybeSingle()
    if (row?.id) return String(row.id)
  }
  return null
}

type FifoAllocationPlan = {
  layerId: string
  qty: number
  unitCost: number
  remainingBefore: number
}

export async function createInventoryAdjustment(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  userId: string,
  input: CreateAdjustmentBody,
): Promise<MutateResult> {
  const deltaRaw = Number(input.quantityDelta)
  if (!Number.isFinite(deltaRaw) || deltaRaw === 0) {
    return { success: false, error: "La cantidad no es válida.", status: 400 }
  }
  const qtyAbs = Math.abs(deltaRaw)
  if (!Number.isInteger(qtyAbs) || qtyAbs < 1 || qtyAbs > 10000) {
    return {
      success: false,
      error: "La cantidad debe ser un entero entre 1 y 10000.",
      status: 400,
    }
  }
  const delta = deltaRaw > 0 ? qtyAbs : -qtyAbs
  const note = input.note.trim()
  if (note.length < 1) {
    return {
      success: false,
      error: "Indicá un motivo o detalle del ajuste.",
      status: 400,
    }
  }

  const { data: pop } = await supabase
    .from("pops")
    .select("country")
    .eq("id", popId)
    .maybeSingle()
  const tz = timezoneForPopLedger(pop?.country, popSiteId)
  const entryDate = entryDateIsoInTimezone(tz)
  const inboundExpiresAt =
    delta > 0 ? parseInventoryExpiresAt(input.expiresAt) : null

  const location = input.locationId
    ? await resolvePopInventoryLocationId(supabase, popId, input.locationId)
    : await ensurePopDefaultInventoryLocationId(supabase, popId)
  if (!location.success) {
    return { success: false, error: location.error, status: 400 }
  }

  const { data: artRow, error: artErr } = await supabase
    .from("articles")
    .select("id, name")
    .eq("id", input.articleId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (artErr || !artRow) {
    return {
      success: false,
      error: "Artículo no encontrado en este punto.",
      status: 404,
    }
  }
  const articleName = String(artRow.name ?? "")
  const articleCostRef = roundMoney(
    await resolveArticleReferenceUnitCost(supabase, popId, input.articleId),
  )
  const isIncrease = delta > 0

  if (!isIncrease) {
    const oh = await sumInventoryOnHandForArticle(
      supabase,
      popId,
      input.articleId,
      location.locationId,
    )
    if (!oh.success) return { success: false, error: oh.error, status: 500 }
    if (qtyAbs > oh.onHand + 1e-6) {
      return {
        success: false,
        error: "El stock no alcanza para restar esa cantidad.",
        status: 400,
      }
    }
  }

  let amount = 0
  let valuationUnitForLayer: number | null = null
  let fifoAllocations: FifoAllocationPlan[] = []

  if (isIncrease) {
    const u = articleCostRef > 0 ? articleCostRef : null
    if (u == null || u <= 0) {
      return { success: false, error: articleReferenceCostError(articleName), status: 400 }
    }
    valuationUnitForLayer = u
    amount = roundMoney(delta * u)
  } else {
    const { data: layerRows, error: lrErr } = await applyInventoryFefoOrder(
      supabase
        .from("inventory_cost_layers")
        .select("id, quantity_remaining, unit_cost, received_at, expires_at")
        .eq("pop_id", popId)
        .eq("article_id", input.articleId)
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
    if (layers.length === 0) {
      const u = articleCostRef > 0 ? articleCostRef : null
      if (u == null || u <= 0) {
        return {
          success: false,
          error: articleReferenceCostError(articleName),
          status: 400,
        }
      }
      amount = roundMoney(qtyAbs * u)
    } else {
      let need = qtyAbs
      let total = 0
      const plans: FifoAllocationPlan[] = []
      for (const row of layers) {
        if (need <= 0) break
        const rem = parseQty(row.quantity_remaining)
        if (rem <= 0) continue
        const take = Math.min(need, rem)
        const uc = parseQty(row.unit_cost)
        total += roundMoney(take * uc)
        plans.push({
          layerId: String(row.id),
          qty: take,
          unitCost: uc,
          remainingBefore: rem,
        })
        need = parseQty(need - take)
      }
      if (need > 0) {
        const u = articleCostRef > 0 ? articleCostRef : null
        if (u == null || u <= 0) {
          return {
            success: false,
            error: articleReferenceCostError(articleName),
            status: 400,
          }
        }
        total += roundMoney(need * u)
      }
      amount = roundMoney(total)
      fifoAllocations = plans
    }
  }

  if (amount <= 0) {
    return {
      success: false,
      error: "El importe del asiento debe ser mayor que cero.",
      status: 400,
    }
  }

  const mercaderiasId = await resolveAccountId(
    supabase,
    popId,
    CHART_MERCADERIAS_CODES,
  )
  if (!mercaderiasId) {
    return {
      success: false,
      error:
        "No hay cuenta de inventario (p. ej. 1.1.3.01 Mercaderías) en el plan de cuentas de este punto.",
      status: 400,
    }
  }
  const offsetId = isIncrease
    ? await resolveAccountId(supabase, popId, CHART_INGRESO_AJUSTE_CODES)
    : await resolveAccountId(supabase, popId, CHART_GASTO_MERMA_CODES)
  if (!offsetId) {
    return {
      success: false,
      error: isIncrease
        ? "No hay cuenta de ingresos para ajustes (p. ej. 4.2.1.01 Otros ingresos)."
        : "No hay cuenta de gastos para mermas (p. ej. 6.2.1.03 Mermas y pérdidas de inventario).",
      status: 400,
    }
  }

  const entryDescription = `Ajuste inventario — ${articleName || "Artículo"}`

  async function undoFifoAfterMovementFailure(mid: string) {
    if (isIncrease && valuationUnitForLayer != null) {
      await supabase.from("inventory_cost_layers").delete().eq("source_movement_id", mid)
    }
    if (!isIncrease && fifoAllocations.length > 0) {
      for (const r of fifoAllocations) {
        await supabase
          .from("inventory_cost_layers")
          .update({ quantity_remaining: r.remainingBefore })
          .eq("id", r.layerId)
      }
    }
    await supabase.from("inventory_movements").delete().eq("id", mid)
  }

  const { data: movIns, error: movErr } = await supabase
    .from("inventory_movements")
    .insert({
      pop_id: popId,
      location_id: location.locationId,
      article_id: input.articleId,
      quantity_delta: delta,
      movement_type: "adjustment",
      note,
      created_by: userId,
    })
    .select("id")
    .single()
  if (movErr || !movIns?.id) {
    return {
      success: false,
      error: movErr?.message || "No se pudo guardar el movimiento.",
      status: 500,
    }
  }
  const movementId = String(movIns.id)

  if (isIncrease && valuationUnitForLayer != null) {
    const { error: posLayerErr } = await supabase.from("inventory_cost_layers").insert({
      pop_id: popId,
      location_id: location.locationId,
      article_id: input.articleId,
      source_movement_id: movementId,
      quantity_received: delta,
      quantity_remaining: delta,
      unit_cost: valuationUnitForLayer,
      expires_at: inboundExpiresAt,
    })
    if (posLayerErr) {
      await supabase.from("inventory_movements").delete().eq("id", movementId)
      return {
        success: false,
        error: posLayerErr.message || "No se pudo registrar la capa de costo del ajuste.",
        status: 500,
      }
    }
  } else if (!isIncrease && fifoAllocations.length > 0) {
    for (const a of fifoAllocations) {
      const { error: allocInsErr } = await supabase
        .from("inventory_layer_allocations")
        .insert({
          pop_id: popId,
          layer_id: a.layerId,
          article_id: input.articleId,
          inventory_movement_id: movementId,
          quantity: a.qty,
          unit_cost: a.unitCost,
        })
      if (allocInsErr) {
        await supabase.from("inventory_movements").delete().eq("id", movementId)
        return {
          success: false,
          error: allocInsErr.message || "No se pudo registrar la imputación FIFO.",
          status: 500,
        }
      }
    }
    for (const a of fifoAllocations) {
      const newRem = parseQty(a.remainingBefore - a.qty)
      const { error: layUpdErr } = await supabase
        .from("inventory_cost_layers")
        .update({ quantity_remaining: newRem })
        .eq("id", a.layerId)
      if (layUpdErr) {
        for (const r of fifoAllocations) {
          await supabase
            .from("inventory_cost_layers")
            .update({ quantity_remaining: r.remainingBefore })
            .eq("id", r.layerId)
        }
        await supabase.from("inventory_movements").delete().eq("id", movementId)
        return {
          success: false,
          error: layUpdErr.message || "No se pudo actualizar la capa de costo.",
          status: 500,
        }
      }
    }
  }

  const { data: maxRow } = await supabase
    .from("accounting_entries")
    .select("entry_number")
    .eq("pop_id", popId)
    .order("entry_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextNum =
    maxRow?.entry_number != null && Number.isFinite(Number(maxRow.entry_number))
      ? Number(maxRow.entry_number) + 1
      : 1

  const { data: entIns, error: entErr } = await supabase
    .from("accounting_entries")
    .insert({
      pop_id: popId,
      entry_number: nextNum,
      entry_date: entryDate,
      source_type: "inventory_adjustment",
      source_id: movementId,
      description: entryDescription,
      status: "draft",
      created_by: userId,
    })
    .select("id")
    .single()
  if (entErr || !entIns?.id) {
    await undoFifoAfterMovementFailure(movementId)
    return {
      success: false,
      error: entErr?.message || "No se pudo crear el asiento.",
      status: 500,
    }
  }
  const entryId = String(entIns.id)

  const lineMercaderias = isIncrease
    ? {
        account_id: mercaderiasId,
        debit_amount: amount,
        credit_amount: 0,
        description: note,
        line_order: 1,
      }
    : {
        account_id: mercaderiasId,
        debit_amount: 0,
        credit_amount: amount,
        description: note,
        line_order: 2,
      }
  const lineOffset = isIncrease
    ? {
        account_id: offsetId,
        debit_amount: 0,
        credit_amount: amount,
        description: note,
        line_order: 2,
      }
    : {
        account_id: offsetId,
        debit_amount: amount,
        credit_amount: 0,
        description: note,
        line_order: 1,
      }

  const { error: linesErr } = await supabase.from("accounting_entry_lines").insert(
    [lineMercaderias, lineOffset].map((l) => ({ ...l, entry_id: entryId })),
  )
  if (linesErr) {
    await supabase.from("accounting_entries").delete().eq("id", entryId)
    await undoFifoAfterMovementFailure(movementId)
    return {
      success: false,
      error: linesErr.message || "No se pudieron crear las líneas del asiento.",
      status: 500,
    }
  }

  const { error: postErr } = await supabase
    .from("accounting_entries")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
    })
    .eq("id", entryId)
  if (postErr) {
    await supabase.from("accounting_entries").delete().eq("id", entryId)
    await undoFifoAfterMovementFailure(movementId)
    return {
      success: false,
      error: postErr.message || "No se pudo registrar el asiento.",
      status: 500,
    }
  }

  return { success: true }
}

export async function deleteInventoryMovement(
  supabase: SupabaseClient,
  popId: string,
  movementId: string,
): Promise<MutateResult> {
  const { error } = await supabase
    .from("inventory_movements")
    .delete()
    .eq("id", movementId)
    .eq("pop_id", popId)
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo eliminar.",
      status: 500,
    }
  }
  return { success: true }
}

export async function applyInventoryMinStockRecommendations(
  supabase: SupabaseClient,
  popId: string,
  input: ApplyMinStockBody,
): Promise<ApplyResult> {
  const built = await listInventoryArticleRows(supabase, popId)
  if (!built.success) {
    return { success: false, error: built.error, status: 500 }
  }
  const wanted = input.articleIds?.length ? new Set(input.articleIds) : null
  const pending = built.articleRows.filter((row) => {
    if (row.suggestedMin == null) return false
    if (wanted && !wanted.has(row.articleId)) return false
    return true
  })
  if (pending.length === 0) {
    return {
      success: false,
      error: "No hay recomendaciones para aplicar.",
      status: 400,
    }
  }
  let applied = 0
  for (const row of pending) {
    const { error } = await supabase
      .from("articles")
      .update({ min_stock_level: row.suggestedMin })
      .eq("id", row.articleId)
      .eq("pop_id", popId)
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudieron guardar los mínimos.",
        status: 500,
      }
    }
    applied += 1
  }
  return { success: true, data: { applied } }
}
