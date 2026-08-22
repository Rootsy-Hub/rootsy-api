import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import {
  inventoryExpiryAlert,
  parseInventoryExpiresAt,
} from "./expiry.js"
import {
  buildInventoryLocationRows,
  ensurePopDefaultInventoryLocationId,
  resolvePopInventoryLocationId,
  sumInventoryOnHandForArticle,
} from "./locations.js"
import { parseQty, roundMoney } from "./qty.js"
import type {
  InventoryArticleRow,
  InventoryArticleSearchHit,
  InventoryCostLayerRow,
  InventoryExpirySummary,
  InventoryLayerAllocationRow,
  InventoryLedgerData,
  InventoryListData,
  InventoryLocationRow,
  InventoryLocationSlim,
  InventoryMetrics,
  InventoryMovementRow,
} from "./schema.js"
import {
  INVENTORY_RECOMMENDATION_LOOKBACK_DAYS,
  classifyInventoryAttention,
  recommendMinFromDailyOutflow,
  suggestedMaxFromMin,
  suggestedPurchaseQty,
} from "./stockLevels.js"

const UNIT_ORDER: Record<string, number> = {
  unidad: 0,
  caja: 1,
  kg: 2,
  g: 3,
  lt: 4,
  ml: 5,
  m: 6,
  cm: 7,
}

function emptyInventoryMetrics(): InventoryMetrics {
  return {
    articleCount: 0,
    articlesWithStock: 0,
    unitsInStock: 0,
    unitsByMeasure: [],
    inventoryValue: 0,
    redCount: 0,
    negativeCount: 0,
    emptyCount: 0,
    belowMinCount: 0,
    overstockCount: 0,
    purchaseCount: 0,
    recommendationCount: 0,
  }
}

function buildInventoryMetrics(rows: InventoryArticleRow[]): InventoryMetrics {
  const metrics = emptyInventoryMetrics()
  metrics.articleCount = rows.length
  const byUnit = new Map<string, { quantity: number; articleCount: number }>()
  for (const row of rows) {
    if (row.onHand > 1e-6) {
      metrics.articlesWithStock += 1
      metrics.unitsInStock = roundMoney(metrics.unitsInStock + row.onHand)
      metrics.inventoryValue = roundMoney(
        metrics.inventoryValue + row.inventoryValue,
      )
      const unit = row.unitOfMeasure.trim() || "unidad"
      const prev = byUnit.get(unit) ?? { quantity: 0, articleCount: 0 }
      prev.quantity = Math.round((prev.quantity + row.onHand) * 1e6) / 1e6
      prev.articleCount += 1
      byUnit.set(unit, prev)
    }
    if (row.attention === "negative") metrics.negativeCount += 1
    if (row.attention === "empty") metrics.emptyCount += 1
    if (row.attention === "below_min") metrics.belowMinCount += 1
    if (row.attention === "overstock") metrics.overstockCount += 1
    if (row.qtyToBuy > 0) metrics.purchaseCount += 1
    if (row.suggestedMin != null) metrics.recommendationCount += 1
  }
  metrics.redCount =
    metrics.negativeCount + metrics.emptyCount + metrics.belowMinCount
  metrics.unitsByMeasure = [...byUnit.entries()]
    .map(([unitOfMeasure, value]) => ({
      unitOfMeasure,
      quantity: value.quantity,
      articleCount: value.articleCount,
    }))
    .sort((a, b) => {
      const orderA = UNIT_ORDER[a.unitOfMeasure] ?? 50
      const orderB = UNIT_ORDER[b.unitOfMeasure] ?? 50
      if (orderA !== orderB) return orderA - orderB
      return a.unitOfMeasure.localeCompare(b.unitOfMeasure, "es")
    })
  return metrics
}

function emptyExpiry(): InventoryExpirySummary {
  return { expiredCount: 0, soonCount: 0, total: 0 }
}

async function buildArticleRows(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; articleRows: InventoryArticleRow[] }
  | { success: false; error: string }
> {
  const { data: artRows, error: artErr } = await supabase
    .from("articles")
    .select("id, name, min_stock_level, unit_of_measure, track_stock")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("name", { ascending: true })
  if (artErr) {
    return {
      success: false,
      error: artErr.message || "No se pudieron cargar artículos.",
    }
  }
  const articleIds = (artRows || []).map((r) => String(r.id))
  const referenceUnitCosts = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    articleIds,
  )

  const { data: sumRows, error: sumErr } = await supabase
    .from("inventory_movements")
    .select("article_id, quantity_delta")
    .eq("pop_id", popId)
  if (sumErr) {
    return {
      success: false,
      error: sumErr.message || "No se pudieron calcular saldos.",
    }
  }
  const deltaByArticle = new Map<string, number>()
  for (const r of sumRows || []) {
    const aid = String(r.article_id)
    deltaByArticle.set(aid, (deltaByArticle.get(aid) ?? 0) + parseQty(r.quantity_delta))
  }

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - INVENTORY_RECOMMENDATION_LOOKBACK_DAYS)
  const { data: saleRows } = await supabase
    .from("inventory_movements")
    .select("article_id, quantity_delta")
    .eq("pop_id", popId)
    .eq("movement_type", "sale")
    .gte("created_at", since.toISOString())

  const outflowByArticle = new Map<string, number>()
  for (const row of saleRows || []) {
    const aid = String(row.article_id)
    outflowByArticle.set(
      aid,
      (outflowByArticle.get(aid) ?? 0) + Math.abs(parseQty(row.quantity_delta)),
    )
  }

  const articleRows: InventoryArticleRow[] = (artRows || []).map((row) => {
    const articleId = String(row.id)
    const minRaw = row.min_stock_level
    const minLevel =
      minRaw != null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : null
    const onHand = Math.round((deltaByArticle.get(articleId) ?? 0) * 1e6) / 1e6
    const unitCost = referenceUnitCosts.get(articleId) ?? 0
    const attention = classifyInventoryAttention(onHand, minLevel)
    const avgDailyOutflow =
      (outflowByArticle.get(articleId) ?? 0) /
      INVENTORY_RECOMMENDATION_LOOKBACK_DAYS
    const suggestedMin = recommendMinFromDailyOutflow(
      avgDailyOutflow,
      minLevel,
      onHand,
    )
    return {
      articleId,
      name: String(row.name ?? ""),
      unitOfMeasure: String(row.unit_of_measure ?? ""),
      onHand,
      minLevel,
      unitCost,
      inventoryValue: roundMoney(Math.max(0, onHand) * unitCost),
      attention,
      suggestedMin,
      suggestedMax: suggestedMaxFromMin(suggestedMin ?? minLevel),
      qtyToBuy: suggestedPurchaseQty(onHand, minLevel, suggestedMin),
    }
  })
  articleRows.sort((a, b) => a.name.localeCompare(b.name, "es"))
  return { success: true, articleRows }
}

export async function listInventory(
  supabase: SupabaseClient,
  popId: string,
  todayIso: string,
): Promise<
  { success: true; data: InventoryListData } | { success: false; error: string }
> {
  const built = await buildArticleRows(supabase, popId)
  if (!built.success) return built

  const { data: locRows, error: locErr } = await supabase
    .from("inventory_locations")
    .select("id, name, is_default, is_sellable")
    .eq("pop_id", popId)
    .is("archived_at", null)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (locErr) {
    return {
      success: false,
      error: locErr.message || "No se pudieron cargar los depósitos.",
    }
  }
  const locations: InventoryLocationSlim[] = (locRows || []).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    isDefault: Boolean(row.is_default),
    isSellable: Boolean(row.is_sellable),
  }))

  const { data: layerRows, error: layerErr } = await supabase
    .from("inventory_cost_layers")
    .select("expires_at, quantity_remaining")
    .eq("pop_id", popId)
    .gt("quantity_remaining", 0)
  if (layerErr) {
    return {
      success: false,
      error: layerErr.message || "No se pudieron leer vencimientos.",
    }
  }
  const expiry = emptyExpiry()
  for (const row of layerRows || []) {
    if (parseQty(row.quantity_remaining) <= 1e-6) continue
    const alert = inventoryExpiryAlert(
      parseInventoryExpiresAt(row.expires_at),
      todayIso,
    )
    if (alert === "expired") expiry.expiredCount += 1
    else if (alert) expiry.soonCount += 1
  }
  expiry.total = expiry.expiredCount + expiry.soonCount

  return {
    success: true,
    data: {
      articleRows: built.articleRows,
      metrics: buildInventoryMetrics(built.articleRows),
      locations,
      expiry,
    },
  }
}

export async function listInventoryArticleRows(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; articleRows: InventoryArticleRow[] }
  | { success: false; error: string }
> {
  return buildArticleRows(supabase, popId)
}

export async function listInventoryMovements(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: { movements: InventoryMovementRow[] } }
  | { success: false; error: string }
> {
  const { data: movRows, error: movErr } = await supabase
    .from("inventory_movements")
    .select(
      `
        id,
        article_id,
        quantity_delta,
        movement_type,
        note,
        created_at,
        created_by,
        articles ( name )
      `,
    )
    .eq("pop_id", popId)
    .order("created_at", { ascending: false })
    .limit(250)
  if (movErr) {
    return {
      success: false,
      error: movErr.message || "No se pudieron cargar movimientos.",
    }
  }
  const movements: InventoryMovementRow[] = (movRows || []).map((r) => {
    const art = r.articles as unknown as { name?: string } | null
    const aid = String(r.article_id)
    return {
      id: String(r.id),
      articleId: aid,
      articleName: art?.name ? String(art.name) : aid,
      quantityDelta: parseQty(r.quantity_delta),
      movementType: String(r.movement_type ?? ""),
      note: r.note != null ? String(r.note) : "",
      createdAt: String(r.created_at ?? ""),
      createdBy: r.created_by != null ? String(r.created_by) : null,
    }
  })
  return { success: true, data: { movements } }
}

export async function listInventoryLedger(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  { success: true; data: InventoryLedgerData } | { success: false; error: string }
> {
  const { data: locRows } = await supabase
    .from("inventory_locations")
    .select("id, name")
    .eq("pop_id", popId)
  const locationNameById = new Map(
    (locRows || []).map((row) => [String(row.id), String(row.name ?? "")]),
  )

  const { data: layerRows, error: layerErr } = await supabase
    .from("inventory_cost_layers")
    .select(
      `
        id,
        article_id,
        source_movement_id,
        quantity_received,
        quantity_remaining,
        unit_cost,
        received_at,
        expires_at,
        location_id,
        articles ( name, unit_of_measure )
      `,
    )
    .eq("pop_id", popId)
    .order("received_at", { ascending: true })
  if (layerErr) {
    return {
      success: false,
      error: layerErr.message || "No se pudieron cargar capas de costo.",
    }
  }
  const costLayers: InventoryCostLayerRow[] = (layerRows || []).map((r) => {
    const art = r.articles as unknown as {
      name?: string
      unit_of_measure?: string
    } | null
    const aid = String(r.article_id)
    const locId = r.location_id ? String(r.location_id) : ""
    return {
      id: String(r.id),
      articleId: aid,
      articleName: art?.name ? String(art.name) : aid,
      sourceMovementId:
        r.source_movement_id != null ? String(r.source_movement_id) : null,
      quantityReceived: parseQty(r.quantity_received),
      quantityRemaining: parseQty(r.quantity_remaining),
      unitCost: parseQty(r.unit_cost),
      receivedAt: String(r.received_at ?? ""),
      expiresAt: parseInventoryExpiresAt(r.expires_at),
      locationId: locId,
      locationName: locationNameById.get(locId) || "Depósito",
      unitOfMeasure:
        art?.unit_of_measure != null ? String(art.unit_of_measure) : "",
    }
  })

  const { data: allocRows, error: allocErr } = await supabase
    .from("inventory_layer_allocations")
    .select(
      `
        id,
        layer_id,
        article_id,
        inventory_movement_id,
        quantity,
        unit_cost,
        created_at,
        articles ( name ),
        inventory_movements ( movement_type )
      `,
    )
    .eq("pop_id", popId)
    .order("created_at", { ascending: false })
    .limit(150)
  if (allocErr) {
    return {
      success: false,
      error: allocErr.message || "No se pudieron cargar imputaciones FIFO.",
    }
  }
  const layerAllocations: InventoryLayerAllocationRow[] = (allocRows || []).map(
    (r) => {
      const art = r.articles as unknown as { name?: string } | null
      const mov = r.inventory_movements as unknown as {
        movement_type?: string
      } | null
      const aid = String(r.article_id)
      const q = parseQty(r.quantity)
      const uc = parseQty(r.unit_cost)
      return {
        id: String(r.id),
        layerId: String(r.layer_id),
        articleId: aid,
        articleName: art?.name ? String(art.name) : aid,
        inventoryMovementId: String(r.inventory_movement_id),
        movementType: String(mov?.movement_type ?? ""),
        quantity: q,
        unitCost: uc,
        lineCost: Math.round(q * uc * 1e6) / 1e6,
        createdAt: String(r.created_at ?? ""),
      }
    },
  )

  return { success: true, data: { costLayers, layerAllocations } }
}

export async function listInventoryLocations(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: { locations: InventoryLocationRow[] } }
  | { success: false; error: string }
> {
  const { data: locRows, error: locErr } = await supabase
    .from("inventory_locations")
    .select("id, name, is_default, is_sellable")
    .eq("pop_id", popId)
    .is("archived_at", null)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
  if (locErr) {
    return {
      success: false,
      error: locErr.message || "No se pudieron cargar los depósitos.",
    }
  }

  const { data: sumRows, error: sumErr } = await supabase
    .from("inventory_movements")
    .select("article_id, location_id, quantity_delta")
    .eq("pop_id", popId)
  if (sumErr) {
    return {
      success: false,
      error: sumErr.message || "No se pudieron calcular saldos.",
    }
  }
  const onHandByLocationArticle = new Map<string, number>()
  for (const r of sumRows || []) {
    const locId = r.location_id ? String(r.location_id) : ""
    if (!locId) continue
    const key = `${locId}:${String(r.article_id)}`
    onHandByLocationArticle.set(
      key,
      (onHandByLocationArticle.get(key) ?? 0) + parseQty(r.quantity_delta),
    )
  }

  const { data: layerRows, error: layerErr } = await supabase
    .from("inventory_cost_layers")
    .select("location_id, quantity_remaining, unit_cost")
    .eq("pop_id", popId)
  if (layerErr) {
    return {
      success: false,
      error: layerErr.message || "No se pudieron cargar capas de costo.",
    }
  }
  const remainingValueByLocation = new Map<string, number>()
  for (const r of layerRows || []) {
    const locId = r.location_id ? String(r.location_id) : ""
    if (!locId) continue
    remainingValueByLocation.set(
      locId,
      (remainingValueByLocation.get(locId) ?? 0) +
        parseQty(r.quantity_remaining) * parseQty(r.unit_cost),
    )
  }

  return {
    success: true,
    data: {
      locations: buildInventoryLocationRows({
        locations: (locRows || []).map((row) => ({
          id: String(row.id),
          name: String(row.name ?? ""),
          is_default: Boolean(row.is_default),
          is_sellable: Boolean(row.is_sellable),
        })),
        onHandByKey: onHandByLocationArticle,
        remainingValueByLocation,
      }),
    },
  }
}

export async function searchInventoryArticles(
  supabase: SupabaseClient,
  popId: string,
  query: string,
): Promise<
  | { success: true; data: { articles: InventoryArticleSearchHit[] } }
  | { success: false; error: string }
> {
  const trimmed = query.trim().replace(/,/g, " ").trim()
  if (trimmed.length < 2) {
    return { success: true, data: { articles: [] } }
  }
  const pattern = `%${trimmed.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`
  const { data, error } = await supabase
    .from("articles")
    .select("id, name, unit_of_measure, sku, barcode")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .or(`name.ilike.${pattern},sku.ilike.${pattern},barcode.ilike.${pattern}`)
    .order("name", { ascending: true })
    .limit(12)
  if (error) {
    return { success: false, error: error.message || "No se pudo buscar." }
  }
  return {
    success: true,
    data: {
      articles: (data || []).map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
        unitOfMeasure: String(row.unit_of_measure ?? ""),
        sku:
          row.sku != null && String(row.sku).trim()
            ? String(row.sku).trim()
            : null,
        barcode:
          row.barcode != null && String(row.barcode).trim()
            ? String(row.barcode).trim()
            : null,
      })),
    },
  }
}

export async function getArticleInventoryBalance(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  locationId?: string,
): Promise<
  | { success: true; data: { onHand: number } }
  | { success: false; error: string; status: 400 | 500 }
> {
  const location = locationId
    ? await resolvePopInventoryLocationId(supabase, popId, locationId)
    : await ensurePopDefaultInventoryLocationId(supabase, popId)
  if (!location.success) {
    return { success: false, error: location.error, status: 400 }
  }
  const oh = await sumInventoryOnHandForArticle(
    supabase,
    popId,
    articleId,
    location.locationId,
  )
  if (!oh.success) return { success: false, error: oh.error, status: 500 }
  return { success: true, data: { onHand: oh.onHand } }
}
