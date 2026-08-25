import type { SupabaseClient } from "@supabase/supabase-js"

type DesiredLine = {
  cartLineId: string
  recipeId: string
  recipeName: string
  stationId: string
  quantity: number
  comment: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v != null && !Array.isArray(v)
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function resolveLineId(item: Record<string, unknown>): string {
  const lineId = asString(item.lineId).trim()
  if (lineId) return lineId
  const kind = asString(item.kind) || "article"
  const productoId = asString(item.productoId)
  if (kind === "promotion") return `promotion:${productoId}`
  return `${kind}:${productoId}`
}

function resolveLineComment(
  lineId: string,
  comments: Record<string, unknown> | undefined,
): string {
  if (!comments) return ""
  const direct = asString(comments[lineId]).trim()
  if (direct) return direct
  const regular = asString(comments[`row:${lineId}:regular`]).trim()
  if (regular) return regular
  return ""
}

function recipeIdsFromCheckout(checkout: Record<string, unknown>): string[] {
  const ids = new Set<string>()
  const carrito = Array.isArray(checkout.carrito) ? checkout.carrito : []
  for (const raw of carrito) {
    if (!isRecord(raw)) continue
    const kind = asString(raw.kind)
    if (!kind || kind === "recipe") {
      const id = asString(raw.productoId)
      if (id) ids.add(id)
      continue
    }
    if (kind !== "promotion") continue
    const selections = Array.isArray(raw.promotionSelections)
      ? raw.promotionSelections
      : []
    for (const sel of selections) {
      if (!isRecord(sel) || asString(sel.kind) !== "recipe") continue
      const id = asString(sel.refId)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

function desiredLinesFromCheckout(
  checkout: Record<string, unknown>,
  recipesById: Map<string, { name: string; stationId: string }>,
): DesiredLine[] {
  const out: DesiredLine[] = []
  const carrito = Array.isArray(checkout.carrito) ? checkout.carrito : []
  const comments = isRecord(checkout.itemComentarios)
    ? checkout.itemComentarios
    : undefined
  for (const raw of carrito) {
    if (!isRecord(raw) || asString(raw.comandaStatus) === "voided") continue
    const lineId = resolveLineId(raw)
    const comment = resolveLineComment(lineId, comments)
    const quantity = Math.max(1, Math.round(Number(raw.cantidad) || 1))
    const kind = asString(raw.kind)
    if (!kind || kind === "recipe") {
      const recipe = recipesById.get(asString(raw.productoId))
      if (!recipe) continue
      out.push({
        cartLineId: lineId,
        recipeId: asString(raw.productoId),
        recipeName: recipe.name,
        stationId: recipe.stationId,
        quantity,
        comment,
      })
      continue
    }
    if (kind !== "promotion") continue
    const selections = Array.isArray(raw.promotionSelections)
      ? raw.promotionSelections
      : []
    for (const sel of selections) {
      if (!isRecord(sel) || asString(sel.kind) !== "recipe") continue
      const recipe = recipesById.get(asString(sel.refId))
      if (!recipe) continue
      const slotQty = Math.max(1, Number(sel.slotQuantity) || 1)
      out.push({
        cartLineId: `${lineId}:${asString(sel.slotId)}`,
        recipeId: asString(sel.refId),
        recipeName: recipe.name,
        stationId: recipe.stationId,
        quantity: Math.max(1, quantity * slotQty),
        comment,
      })
    }
  }
  return out
}

async function loadRecipeStations(
  supabase: SupabaseClient,
  popId: string,
  recipeIds: string[],
): Promise<Map<string, { name: string; stationId: string }>> {
  const out = new Map<string, { name: string; stationId: string }>()
  if (recipeIds.length === 0) return out
  const { data, error } = await supabase
    .from("recipes")
    .select("id, name, recipe_categories ( station_id )")
    .eq("pop_id", popId)
    .in("id", recipeIds)
  if (error || !data) return out
  for (const row of data) {
    const rel = row.recipe_categories as
      | { station_id?: string | null }
      | { station_id?: string | null }[]
      | null
    const category = Array.isArray(rel) ? rel[0] : rel
    const stationId = category?.station_id ? String(category.station_id) : ""
    const name = String(row.name ?? "").trim()
    if (!stationId || !name) continue
    out.set(String(row.id), { name, stationId })
  }
  return out
}

function checkoutCustomerName(checkout: Record<string, unknown>): string {
  const selected = isRecord(checkout.clienteSeleccionado)
    ? asString(checkout.clienteSeleccionado.name).trim()
    : ""
  if (selected) return selected
  return asString(checkout.manualNombreCliente).trim()
}

export async function syncComandasFromCounterCheckout(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
  checkout: Record<string, unknown>,
): Promise<void> {
  const { data: order, error: orderErr } = await supabase
    .from("counter_orders")
    .select("id, order_number")
    .eq("id", orderId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (orderErr || !order) return

  const recipesById = await loadRecipeStations(
    supabase,
    popId,
    recipeIdsFromCheckout(checkout),
  )
  const desired = desiredLinesFromCheckout(checkout, recipesById)
  const originLabel = `Pedido #${Number(order.order_number) || 0}`
  const customerName = checkoutCustomerName(checkout)

  const { data: existingRows, error: existingErr } = await supabase
    .from("comandas")
    .select("id, cart_line_id, status, station_id")
    .eq("pop_id", popId)
    .eq("source_kind", "counter")
    .eq("source_id", orderId)
  if (existingErr) return

  const existing = (existingRows ?? []) as {
    id: string
    cart_line_id: string
    status: string
    station_id: string
  }[]
  const existingByLine = new Map(existing.map((row) => [row.cart_line_id, row]))
  const desiredIds = new Set(desired.map((line) => line.cartLineId))
  const leftoverPending = existing.filter(
    (row) => row.status === "pending" && !desiredIds.has(row.cart_line_id),
  )

  if (leftoverPending.length > 0) {
    await supabase
      .from("comandas")
      .delete()
      .eq("pop_id", popId)
      .in(
        "id",
        leftoverPending.map((row) => row.id),
      )
  }

  const toInsert = desired.filter((line) => !existingByLine.has(line.cartLineId))
  if (toInsert.length > 0) {
    await supabase.from("comandas").insert(
      toInsert.map((line) => ({
        pop_id: popId,
        station_id: line.stationId,
        status: "pending",
        source_kind: "counter",
        source_id: orderId,
        table_session_id: null,
        counter_order_id: orderId,
        cart_line_id: line.cartLineId,
        recipe_id: line.recipeId,
        recipe_name: line.recipeName,
        quantity: line.quantity,
        comment: line.comment,
        origin_label: originLabel,
        customer_name: customerName,
      })),
    )
  }

  for (const line of desired) {
    const row = existingByLine.get(line.cartLineId)
    if (!row || row.status !== "pending") continue
    await supabase
      .from("comandas")
      .update({
        recipe_name: line.recipeName,
        quantity: line.quantity,
        comment: line.comment,
        origin_label: originLabel,
        customer_name: customerName,
        recipe_id: line.recipeId,
      })
      .eq("id", row.id)
      .eq("pop_id", popId)
  }
}
