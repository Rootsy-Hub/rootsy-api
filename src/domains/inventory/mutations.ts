import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
} from "../../audit/ledgerOps.js"
import { auditedDelete } from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
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
  | { success: false; error: string; status: 400 | 403 | 404 | 500 }

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
  audit: MutationAuditCtx,
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
  const movementId = randomUUID()
  const ops: AuditOp[] = [
    {
      op: "insert",
      table: "inventory_movements",
      row: {
        id: movementId,
        pop_id: popId,
        location_id: location.locationId,
        article_id: input.articleId,
        quantity_delta: delta,
        movement_type: "adjustment",
        note,
        created_by: userId,
      },
    },
  ]

  if (isIncrease && valuationUnitForLayer != null) {
    ops.push({
      op: "insert",
      table: "inventory_cost_layers",
      row: {
        id: randomUUID(),
        pop_id: popId,
        location_id: location.locationId,
        article_id: input.articleId,
        source_movement_id: movementId,
        quantity_received: delta,
        quantity_remaining: delta,
        unit_cost: valuationUnitForLayer,
        expires_at: inboundExpiresAt,
      },
    })
  } else if (!isIncrease && fifoAllocations.length > 0) {
    for (const a of fifoAllocations) {
      ops.push({
        op: "insert",
        table: "inventory_layer_allocations",
        row: {
          id: randomUUID(),
          pop_id: popId,
          layer_id: a.layerId,
          article_id: input.articleId,
          inventory_movement_id: movementId,
          quantity: a.qty,
          unit_cost: a.unitCost,
        },
      })
    }
    for (const a of fifoAllocations) {
      ops.push({
        op: "update",
        table: "inventory_cost_layers",
        id: a.layerId,
        row: { quantity_remaining: parseQty(a.remainingBefore - a.qty) },
      })
    }
  }

  const nextNum = await nextAccountingEntryNumber(supabase, popId)
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
  const ledger = postedAccountingEntryOps({
    popId,
    userId,
    entryNumber: nextNum,
    entryDate,
    sourceType: "inventory_adjustment",
    sourceId: movementId,
    description: entryDescription,
    lines: [lineMercaderias, lineOffset],
  })
  ops.push(...ledger.ops)

  const applied = await applyWithAudit(supabase, {
    kind: "inventory.adjust",
    ctx: audit,
    popId,
    resourceId: movementId,
    previous: null,
    next: { movementId, quantityDelta: delta, articleId: input.articleId },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function deleteInventoryMovement(
  supabase: SupabaseClient,
  popId: string,
  movementId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing } = await supabase
    .from("inventory_movements")
    .select("id, article_id, quantity_delta")
    .eq("id", movementId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (!existing?.id) {
    return { success: false, error: "No se encontró el movimiento.", status: 404 }
  }
  const applied = await auditedDelete(supabase, {
    kind: "inventory.movement.delete",
    table: "inventory_movements",
    id: movementId,
    ctx: audit,
    popId,
    previous: existing,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function applyInventoryMinStockRecommendations(
  supabase: SupabaseClient,
  popId: string,
  input: ApplyMinStockBody,
  audit: MutationAuditCtx,
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
  const ops: AuditOp[] = pending.map((row) => ({
    op: "update",
    table: "articles",
    id: row.articleId,
    row: { min_stock_level: row.suggestedMin },
  }))
  const applied = await applyWithAudit(supabase, {
    kind: "inventory.min_stock",
    ctx: audit,
    popId,
    resourceId: pending[0]?.articleId ?? null,
    previous: null,
    next: { applied: pending.length },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, data: { applied: pending.length } }
}
