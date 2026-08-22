import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import { CHART_MERCADERIAS_CODES } from "./chart.js"
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
  InventoryExpiryData,
  InventoryLayerAllocationRow,
  InventoryLedgerAllocationsData,
  InventoryLedgerLayersData,
  InventoryLocationRow,
  InventoryLocationSlim,
  InventoryMetrics,
  InventoryMovementRow,
  InventoryMovementsData,
  InventoryRowsData,
  InventorySummaryData,
  ListExpiryQuery,
  ListLedgerQuery,
  ListMovementsQuery,
  ListRowsQuery,
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

function emptyExpiry(): InventoryExpirySummary {
  return { expiredCount: 0, soonCount: 0, total: 0 }
}

async function loadSlimLocations(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; locations: InventoryLocationSlim[] }
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
  return {
    success: true,
    locations: (locRows || []).map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      isDefault: Boolean(row.is_default),
      isSellable: Boolean(row.is_sellable),
    })),
  }
}

async function loadExpirySummary(
  supabase: SupabaseClient,
  popId: string,
  todayIso: string,
): Promise<
  { success: true; expiry: InventoryExpirySummary } | { success: false; error: string }
> {
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
  return { success: true, expiry }
}

async function merchandiseBookValue(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  { success: true; value: number } | { success: false; error: string }
> {
  const { data: accounts, error: accErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id")
    .eq("pop_id", popId)
    .in("code", [...CHART_MERCADERIAS_CODES])
  if (accErr) {
    return {
      success: false,
      error: accErr.message || "No se pudieron leer las cuentas de inventario.",
    }
  }
  const accountIds = (accounts || [])
    .map((row) => String(row.id))
    .filter(Boolean)
  if (accountIds.length === 0) return { success: true, value: 0 }

  const { data: lines, error: lineErr } = await supabase
    .from("accounting_entry_lines")
    .select(
      "debit_amount, credit_amount, accounting_entries!inner ( pop_id, status )",
    )
    .in("account_id", accountIds)
    .eq("accounting_entries.pop_id", popId)
    .eq("accounting_entries.status", "posted")
  if (lineErr) {
    return {
      success: false,
      error: lineErr.message || "No se pudo leer el saldo de mercaderías.",
    }
  }
  let value = 0
  for (const line of lines || []) {
    value += parseQty(line.debit_amount) - parseQty(line.credit_amount)
  }
  return { success: true, value: roundMoney(value) }
}

export async function listInventorySummary(
  supabase: SupabaseClient,
  popId: string,
  todayIso: string,
): Promise<
  | { success: true; data: InventorySummaryData }
  | { success: false; error: string }
> {
  const [arts, onHand, book, locations, expiry] = await Promise.all([
    supabase
      .from("articles")
      .select("id, min_stock_level, unit_of_measure")
      .eq("pop_id", popId)
      .eq("is_active", true),
    supabase
      .from("inventory_on_hand")
      .select("article_id, quantity")
      .eq("pop_id", popId),
    merchandiseBookValue(supabase, popId),
    loadSlimLocations(supabase, popId),
    loadExpirySummary(supabase, popId, todayIso),
  ])

  if (arts.error) {
    return {
      success: false,
      error: arts.error.message || "No se pudieron cargar artículos.",
    }
  }
  if (onHand.error) {
    return {
      success: false,
      error: onHand.error.message || "No se pudieron leer los saldos.",
    }
  }
  if (!book.success) return book
  if (!locations.success) return locations
  if (!expiry.success) return expiry

  const qtyByArticle = new Map<string, number>()
  for (const row of onHand.data || []) {
    const aid = String(row.article_id)
    qtyByArticle.set(aid, (qtyByArticle.get(aid) ?? 0) + parseQty(row.quantity))
  }

  const metrics = emptyInventoryMetrics()
  metrics.articleCount = (arts.data || []).length
  metrics.inventoryValue = book.value
  const byUnit = new Map<string, { quantity: number; articleCount: number }>()

  for (const row of arts.data || []) {
    const articleId = String(row.id)
    const minRaw = row.min_stock_level
    const minLevel =
      minRaw != null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : null
    const onHandQty =
      Math.round((qtyByArticle.get(articleId) ?? 0) * 1e6) / 1e6
    const attention = classifyInventoryAttention(onHandQty, minLevel)
    if (onHandQty > 1e-6) {
      metrics.articlesWithStock += 1
      metrics.unitsInStock = roundMoney(metrics.unitsInStock + onHandQty)
      const unit = String(row.unit_of_measure ?? "").trim() || "unidad"
      const prev = byUnit.get(unit) ?? { quantity: 0, articleCount: 0 }
      prev.quantity = Math.round((prev.quantity + onHandQty) * 1e6) / 1e6
      prev.articleCount += 1
      byUnit.set(unit, prev)
    }
    if (attention === "negative") metrics.negativeCount += 1
    if (attention === "empty") metrics.emptyCount += 1
    if (attention === "below_min") metrics.belowMinCount += 1
    if (attention === "overstock") metrics.overstockCount += 1
    if (suggestedPurchaseQty(onHandQty, minLevel, null) > 0) {
      metrics.purchaseCount += 1
    }
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

  return {
    success: true,
    data: {
      metrics,
      locations: locations.locations,
      expiry: expiry.expiry,
    },
  }
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
    .from("inventory_on_hand")
    .select("article_id, quantity")
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
    deltaByArticle.set(aid, (deltaByArticle.get(aid) ?? 0) + parseQty(r.quantity))
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

function escapeIlike(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function isRedAttention(
  attention: InventoryArticleRow["attention"],
): boolean {
  return (
    attention === "negative" ||
    attention === "empty" ||
    attention === "below_min"
  )
}

async function attachPageCosts(
  supabase: SupabaseClient,
  popId: string,
  pageRows: InventoryArticleRow[],
) {
  const costs = await resolveArticleReferenceUnitCostsByArticleId(
    supabase,
    popId,
    pageRows.map((row) => row.articleId),
  )
  for (const row of pageRows) {
    const unitCost = costs.get(row.articleId) ?? 0
    row.unitCost = unitCost
    row.inventoryValue = roundMoney(Math.max(0, row.onHand) * unitCost)
  }
}

export async function listInventoryRows(
  supabase: SupabaseClient,
  popId: string,
  input: ListRowsQuery,
): Promise<
  { success: true; data: InventoryRowsData } | { success: false; error: string }
> {
  const q = input.q.trim().replace(/,/g, " ").trim()
  if (input.view === "pantry") {
    const start = (input.page - 1) * input.pageSize
    const end = start + input.pageSize - 1
    const like = q.length >= 1 ? `%${escapeIlike(q)}%` : null
    let countQuery = supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("pop_id", popId)
      .eq("is_active", true)
    let pageQuery = supabase
      .from("articles")
      .select("id, name, min_stock_level, unit_of_measure")
      .eq("pop_id", popId)
      .eq("is_active", true)
      .order("name", { ascending: true })
      .range(start, end)
    if (like) {
      countQuery = countQuery.ilike("name", like)
      pageQuery = pageQuery.ilike("name", like)
    }
    const [{ count, error: countErr }, { data: artRows, error: artErr }] =
      await Promise.all([countQuery, pageQuery])
    if (countErr) {
      return {
        success: false,
        error: countErr.message || "No se pudieron contar artículos.",
      }
    }
    if (artErr) {
      return {
        success: false,
        error: artErr.message || "No se pudieron cargar artículos.",
      }
    }
    const pageArticles = artRows || []
    const ids = pageArticles.map((row) => String(row.id))
    const qtyByArticle = new Map<string, number>()
    if (ids.length > 0) {
      const { data: onHandRows, error: onHandErr } = await supabase
        .from("inventory_on_hand")
        .select("article_id, quantity")
        .eq("pop_id", popId)
        .in("article_id", ids)
      if (onHandErr) {
        return {
          success: false,
          error: onHandErr.message || "No se pudieron leer los saldos.",
        }
      }
      for (const row of onHandRows || []) {
        const aid = String(row.article_id)
        qtyByArticle.set(
          aid,
          (qtyByArticle.get(aid) ?? 0) + parseQty(row.quantity),
        )
      }
    }
    const pageRows: InventoryArticleRow[] = pageArticles.map((row) => {
      const articleId = String(row.id)
      const minRaw = row.min_stock_level
      const minLevel =
        minRaw != null && Number.isFinite(Number(minRaw))
          ? Number(minRaw)
          : null
      const onHand = Math.round((qtyByArticle.get(articleId) ?? 0) * 1e6) / 1e6
      const attention = classifyInventoryAttention(onHand, minLevel)
      return {
        articleId,
        name: String(row.name ?? ""),
        unitOfMeasure: String(row.unit_of_measure ?? ""),
        onHand,
        minLevel,
        unitCost: 0,
        inventoryValue: 0,
        attention,
        suggestedMin: null,
        suggestedMax: suggestedMaxFromMin(minLevel),
        qtyToBuy: suggestedPurchaseQty(onHand, minLevel, null),
      }
    })
    await attachPageCosts(supabase, popId, pageRows)
    return {
      success: true,
      data: {
        rows: pageRows,
        total: count ?? 0,
        page: input.page,
        pageSize: input.pageSize,
      },
    }
  }

  let articlesQuery = supabase
    .from("articles")
    .select("id, name, min_stock_level, unit_of_measure")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("name", { ascending: true })
  if (q.length >= 1) {
    articlesQuery = articlesQuery.ilike("name", `%${escapeIlike(q)}%`)
  }
  const [{ data: artRows, error: artErr }, { data: onHandRows, error: onHandErr }] =
    await Promise.all([
      articlesQuery,
      supabase
        .from("inventory_on_hand")
        .select("article_id, quantity")
        .eq("pop_id", popId),
    ])
  if (artErr) {
    return {
      success: false,
      error: artErr.message || "No se pudieron cargar artículos.",
    }
  }
  if (onHandErr) {
    return {
      success: false,
      error: onHandErr.message || "No se pudieron leer los saldos.",
    }
  }

  const qtyByArticle = new Map<string, number>()
  for (const row of onHandRows || []) {
    const aid = String(row.article_id)
    qtyByArticle.set(aid, (qtyByArticle.get(aid) ?? 0) + parseQty(row.quantity))
  }

  const outflowByArticle = new Map<string, number>()
  if (input.view === "recommend") {
    const since = new Date()
    since.setUTCDate(
      since.getUTCDate() - INVENTORY_RECOMMENDATION_LOOKBACK_DAYS,
    )
    const { data: saleRows } = await supabase
      .from("inventory_movements")
      .select("article_id, quantity_delta")
      .eq("pop_id", popId)
      .eq("movement_type", "sale")
      .gte("created_at", since.toISOString())
    for (const row of saleRows || []) {
      const aid = String(row.article_id)
      outflowByArticle.set(
        aid,
        (outflowByArticle.get(aid) ?? 0) + Math.abs(parseQty(row.quantity_delta)),
      )
    }
  }

  let rows: InventoryArticleRow[] = (artRows || []).map((row) => {
    const articleId = String(row.id)
    const minRaw = row.min_stock_level
    const minLevel =
      minRaw != null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : null
    const onHand = Math.round((qtyByArticle.get(articleId) ?? 0) * 1e6) / 1e6
    const attention = classifyInventoryAttention(onHand, minLevel)
    const suggestedMin =
      input.view === "recommend"
        ? recommendMinFromDailyOutflow(
            (outflowByArticle.get(articleId) ?? 0) /
              INVENTORY_RECOMMENDATION_LOOKBACK_DAYS,
            minLevel,
            onHand,
          )
        : null
    return {
      articleId,
      name: String(row.name ?? ""),
      unitOfMeasure: String(row.unit_of_measure ?? ""),
      onHand,
      minLevel,
      unitCost: 0,
      inventoryValue: 0,
      attention,
      suggestedMin,
      suggestedMax: suggestedMaxFromMin(suggestedMin ?? minLevel),
      qtyToBuy: suggestedPurchaseQty(onHand, minLevel, suggestedMin),
    }
  })

  if (input.view === "red") {
    rows = rows.filter((row) => {
      if (!isRedAttention(row.attention)) return false
      if (!input.attention) return true
      return row.attention === input.attention
    })
  } else if (input.view === "overstock") {
    rows = rows.filter((row) => row.attention === "overstock")
  } else if (input.view === "purchase") {
    rows = rows
      .filter((row) => row.qtyToBuy > 0)
      .sort((a, b) => b.qtyToBuy - a.qtyToBuy)
  } else if (input.view === "recommend") {
    rows = rows.filter((row) => row.suggestedMin != null)
  }

  const total = rows.length
  const start = (input.page - 1) * input.pageSize
  const pageRows = rows.slice(start, start + input.pageSize)
  await attachPageCosts(supabase, popId, pageRows)

  return {
    success: true,
    data: {
      rows: pageRows,
      total,
      page: input.page,
      pageSize: input.pageSize,
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
  input: ListMovementsQuery,
): Promise<
  | { success: true; data: InventoryMovementsData }
  | { success: false; error: string }
> {
  const start = (input.page - 1) * input.pageSize
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
    .order("id", { ascending: false })
    .range(start, start + input.pageSize)
  if (movErr) {
    return {
      success: false,
      error: movErr.message || "No se pudieron cargar movimientos.",
    }
  }
  const fetched = movRows || []
  const hasMore = fetched.length > input.pageSize
  const movements: InventoryMovementRow[] = fetched
    .slice(0, input.pageSize)
    .map((r) => {
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
  return {
    success: true,
    data: {
      movements,
      page: input.page,
      pageSize: input.pageSize,
      hasMore,
    },
  }
}

const COST_LAYER_SELECT = `
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
`

async function locationNameByIdMap(
  supabase: SupabaseClient,
  popId: string,
) {
  const { data: locRows } = await supabase
    .from("inventory_locations")
    .select("id, name")
    .eq("pop_id", popId)
  return new Map(
    (locRows || []).map((row) => [String(row.id), String(row.name ?? "")]),
  )
}

function mapCostLayerRow(
  r: Record<string, unknown>,
  locationNameById: Map<string, string>,
): InventoryCostLayerRow {
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
}

function addDaysIso(todayIso: string, days: number): string {
  const [year, month, day] = todayIso.split("-").map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export async function listInventoryLedgerLayers(
  supabase: SupabaseClient,
  popId: string,
  input: Pick<ListLedgerQuery, "page" | "pageSize">,
): Promise<
  | { success: true; data: InventoryLedgerLayersData }
  | { success: false; error: string }
> {
  const start = (input.page - 1) * input.pageSize
  const locationNameById = await locationNameByIdMap(supabase, popId)
  const { data: layerRows, error: layerErr } = await supabase
    .from("inventory_cost_layers")
    .select(COST_LAYER_SELECT)
    .eq("pop_id", popId)
    .order("received_at", { ascending: true })
    .order("id", { ascending: true })
    .range(start, start + input.pageSize)
  if (layerErr) {
    return {
      success: false,
      error: layerErr.message || "No se pudieron cargar capas de costo.",
    }
  }
  const fetched = layerRows || []
  return {
    success: true,
    data: {
      costLayers: fetched
        .slice(0, input.pageSize)
        .map((row) => mapCostLayerRow(row, locationNameById)),
      page: input.page,
      pageSize: input.pageSize,
      hasMore: fetched.length > input.pageSize,
    },
  }
}

export async function listInventoryLedgerAllocations(
  supabase: SupabaseClient,
  popId: string,
  input: Pick<ListLedgerQuery, "page" | "pageSize">,
): Promise<
  | { success: true; data: InventoryLedgerAllocationsData }
  | { success: false; error: string }
> {
  const start = (input.page - 1) * input.pageSize
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
    .order("id", { ascending: false })
    .range(start, start + input.pageSize)
  if (allocErr) {
    return {
      success: false,
      error: allocErr.message || "No se pudieron cargar imputaciones FIFO.",
    }
  }
  const fetched = allocRows || []
  const layerAllocations: InventoryLayerAllocationRow[] = fetched
    .slice(0, input.pageSize)
    .map((r) => {
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
    })
  return {
    success: true,
    data: {
      layerAllocations,
      page: input.page,
      pageSize: input.pageSize,
      hasMore: fetched.length > input.pageSize,
    },
  }
}

export async function listInventoryExpiryLayers(
  supabase: SupabaseClient,
  popId: string,
  input: ListExpiryQuery,
  todayIso: string,
): Promise<
  | { success: true; data: InventoryExpiryData }
  | { success: false; error: string }
> {
  const start = (input.page - 1) * input.pageSize
  const q = input.q.trim().replace(/,/g, " ").trim()
  const locationNameById = await locationNameByIdMap(supabase, popId)

  let articleIds: string[] | null = null
  let locationIds: string[] | null = null
  if (q.length >= 1) {
    const like = `%${escapeIlike(q)}%`
    const [{ data: artHits }, { data: locHits }] = await Promise.all([
      supabase
        .from("articles")
        .select("id")
        .eq("pop_id", popId)
        .ilike("name", like),
      supabase
        .from("inventory_locations")
        .select("id")
        .eq("pop_id", popId)
        .ilike("name", like),
    ])
    articleIds = (artHits || []).map((row) => String(row.id))
    locationIds = (locHits || []).map((row) => String(row.id))
    if (articleIds.length === 0 && locationIds.length === 0) {
      return {
        success: true,
        data: {
          costLayers: [],
          page: input.page,
          pageSize: input.pageSize,
          hasMore: false,
        },
      }
    }
  }

  let layersQuery = supabase
    .from("inventory_cost_layers")
    .select(COST_LAYER_SELECT)
    .eq("pop_id", popId)
    .gt("quantity_remaining", 0)
    .order("expires_at", { ascending: true, nullsFirst: false })
    .order("received_at", { ascending: true })
    .order("id", { ascending: true })

  if (input.filter === "none") {
    layersQuery = layersQuery.is("expires_at", null)
  } else if (input.filter === "dated") {
    layersQuery = layersQuery.not("expires_at", "is", null)
  } else {
    layersQuery = layersQuery
      .not("expires_at", "is", null)
      .lte("expires_at", addDaysIso(todayIso, 30))
  }

  if (articleIds && locationIds) {
    const parts: string[] = []
    if (articleIds.length > 0) {
      parts.push(`article_id.in.(${articleIds.join(",")})`)
    }
    if (locationIds.length > 0) {
      parts.push(`location_id.in.(${locationIds.join(",")})`)
    }
    layersQuery = layersQuery.or(parts.join(","))
  }

  const { data: layerRows, error: layerErr } = await layersQuery.range(
    start,
    start + input.pageSize,
  )
  if (layerErr) {
    return {
      success: false,
      error: layerErr.message || "No se pudieron cargar vencimientos.",
    }
  }
  const fetched = layerRows || []
  return {
    success: true,
    data: {
      costLayers: fetched
        .slice(0, input.pageSize)
        .map((row) => mapCostLayerRow(row, locationNameById)),
      page: input.page,
      pageSize: input.pageSize,
      hasMore: fetched.length > input.pageSize,
    },
  }
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
    .from("inventory_on_hand")
    .select("article_id, location_id, quantity")
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
    onHandByLocationArticle.set(key, parseQty(r.quantity))
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
