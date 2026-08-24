import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import { resolveArticleReferenceUnitCostsByArticleId } from "../recipes/articleReferenceCost.js"
import { applyInventoryFefoOrder, parseInventoryExpiresAt } from "./expiry.js"
import {
  resolvePopInventoryLocationId,
  sumInventoryOnHandForArticle,
} from "./locations.js"
import { parseQty, roundMoney } from "./qty.js"
import type { TransferBody } from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

type CreateLocationResult =
  | { success: true; data: { locationId: string } }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

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

export async function createInventoryLocation(
  supabase: SupabaseClient,
  popId: string,
  name: string,
  audit: MutationAuditCtx,
): Promise<CreateLocationResult> {
  const trimmed = name.trim()
  if (trimmed.length < 1) {
    return { success: false, error: "Ponéle un nombre al depósito.", status: 400 }
  }
  if (trimmed.length > 60) {
    return { success: false, error: "El nombre es demasiado largo.", status: 400 }
  }
  const { count } = await supabase
    .from("inventory_locations")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .is("archived_at", null)
  const id = randomUUID()
  const row = {
    id,
    pop_id: popId,
    name: trimmed,
    is_default: false,
    is_sellable: false,
    sort_order: (count ?? 0) + 1,
  }
  const applied = await auditedInsert(supabase, {
    kind: "inventory.location.create",
    table: "inventory_locations",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    if (applied.error.includes("duplicate") || applied.error.includes("unique")) {
      return { success: false, error: "Ya hay un depósito con ese nombre.", status: 409 }
    }
    return {
      success: false,
      error: applied.error || "No se pudo crear el depósito.",
      status: applied.status,
    }
  }
  return { success: true, data: { locationId: id } }
}

export async function renameInventoryLocation(
  supabase: SupabaseClient,
  popId: string,
  locationId: string,
  name: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const trimmed = name.trim()
  if (trimmed.length < 1) {
    return { success: false, error: "Ponéle un nombre al depósito.", status: 400 }
  }
  if (trimmed.length > 60) {
    return { success: false, error: "El nombre es demasiado largo.", status: 400 }
  }
  const location = await resolvePopInventoryLocationId(supabase, popId, locationId)
  if (!location.success) return { success: false, error: location.error, status: 400 }
  const applied = await auditedUpdate(supabase, {
    kind: "inventory.location.rename",
    table: "inventory_locations",
    id: location.locationId,
    row: { name: trimmed },
    ctx: audit,
    popId,
    previous: { name: locationId },
    next: { name: trimmed },
  })
  if (!applied.success) {
    if (applied.error.includes("duplicate") || applied.error.includes("unique")) {
      return { success: false, error: "Ya hay un depósito con ese nombre.", status: 409 }
    }
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function archiveInventoryLocation(
  supabase: SupabaseClient,
  popId: string,
  locationId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: loc, error: locErr } = await supabase
    .from("inventory_locations")
    .select("id, is_default")
    .eq("pop_id", popId)
    .eq("id", locationId.trim())
    .is("archived_at", null)
    .maybeSingle()
  if (locErr || !loc?.id) {
    return { success: false, error: "Ese depósito no está disponible.", status: 404 }
  }
  if (loc.is_default) {
    return {
      success: false,
      error: "El depósito principal no se puede archivar.",
      status: 400,
    }
  }
  const { data: movs, error: movErr } = await supabase
    .from("inventory_movements")
    .select("quantity_delta")
    .eq("pop_id", popId)
    .eq("location_id", loc.id)
  if (movErr) {
    return {
      success: false,
      error: movErr.message || "No se pudo revisar el stock.",
      status: 500,
    }
  }
  let onHand = 0
  for (const row of movs || []) onHand += parseQty(row.quantity_delta)
  if (Math.abs(onHand) > 1e-6) {
    return {
      success: false,
      error: "Trasladá o ajustá el stock antes de archivar este depósito.",
      status: 409,
    }
  }
  const { data: openLayers, error: layerErr } = await supabase
    .from("inventory_cost_layers")
    .select("id")
    .eq("pop_id", popId)
    .eq("location_id", loc.id)
    .gt("quantity_remaining", 0)
    .limit(1)
  if (layerErr) {
    return {
      success: false,
      error: layerErr.message || "No se pudieron leer las capas.",
      status: 500,
    }
  }
  if ((openLayers ?? []).length > 0) {
    return {
      success: false,
      error: "Todavía hay capas FIFO en este depósito.",
      status: 409,
    }
  }
  const applied = await auditedUpdate(supabase, {
    kind: "inventory.location.archive",
    table: "inventory_locations",
    id: loc.id,
    row: { archived_at: new Date().toISOString() },
    ctx: audit,
    popId,
    previous: loc,
    next: { ...loc, archived_at: true },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function transferInventoryStock(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: TransferBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  if (input.fromLocationId.trim() === input.toLocationId.trim()) {
    return { success: false, error: "Elegí dos depósitos distintos.", status: 400 }
  }
  const qtyAbs = Number(input.quantity)
  if (!Number.isFinite(qtyAbs) || !Number.isInteger(qtyAbs) || qtyAbs < 1 || qtyAbs > 10000) {
    return {
      success: false,
      error: "La cantidad debe ser un entero entre 1 y 10000.",
      status: 400,
    }
  }

  const from = await resolvePopInventoryLocationId(
    supabase,
    popId,
    input.fromLocationId,
  )
  const to = await resolvePopInventoryLocationId(supabase, popId, input.toLocationId)
  if (!from.success) return { success: false, error: from.error, status: 400 }
  if (!to.success) return { success: false, error: to.error, status: 400 }

  const { data: artRow, error: artErr } = await supabase
    .from("articles")
    .select("id, name")
    .eq("id", input.articleId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (artErr || !artRow) {
    return { success: false, error: "Artículo no encontrado en este punto.", status: 404 }
  }
  const articleName = String(artRow.name ?? "")

  const originOnHand = await sumInventoryOnHandForArticle(
    supabase,
    popId,
    input.articleId,
    from.locationId,
  )
  if (!originOnHand.success) {
    return { success: false, error: originOnHand.error, status: 500 }
  }
  if (qtyAbs > originOnHand.onHand + 1e-6) {
    return { success: false, error: "El origen no tiene esa cantidad.", status: 400 }
  }

  const destOnHand = await sumInventoryOnHandForArticle(
    supabase,
    popId,
    input.articleId,
    to.locationId,
  )
  if (!destOnHand.success) {
    return { success: false, error: destOnHand.error, status: 500 }
  }
  const holeQty =
    destOnHand.onHand < -1e-6
      ? Math.min(qtyAbs, parseQty(-destOnHand.onHand))
      : 0

  const articleCostRef = roundMoney(
    await resolveArticleReferenceUnitCost(supabase, popId, input.articleId),
  )
  const { data: layerRows, error: lrErr } = await applyInventoryFefoOrder(
    supabase
      .from("inventory_cost_layers")
      .select("id, quantity_remaining, unit_cost, received_at, expires_at")
      .eq("pop_id", popId)
      .eq("article_id", input.articleId)
      .eq("location_id", from.locationId)
      .gt("quantity_remaining", 0),
  )
  if (lrErr) {
    return {
      success: false,
      error: lrErr.message || "No se pudieron leer capas de costo.",
      status: 500,
    }
  }

  type Take = {
    layerId: string
    qty: number
    unitCost: number
    remainingBefore: number
    receivedAt: string
    expiresAt: string | null
  }
  const takes: Take[] = []
  let need = qtyAbs
  for (const row of layerRows || []) {
    if (need <= 0) break
    const rem = parseQty(row.quantity_remaining)
    if (rem <= 0) continue
    const take = Math.min(need, rem)
    takes.push({
      layerId: String(row.id),
      qty: take,
      unitCost: parseQty(row.unit_cost),
      remainingBefore: rem,
      receivedAt: String(row.received_at ?? new Date().toISOString()),
      expiresAt: parseInventoryExpiresAt(row.expires_at),
    })
    need = parseQty(need - take)
  }

  type Incoming = {
    qty: number
    unitCost: number
    receivedAt: string
    expiresAt: string | null
  }
  const incoming: Incoming[] = takes.map((take) => ({
    qty: take.qty,
    unitCost: take.unitCost,
    receivedAt: take.receivedAt,
    expiresAt: take.expiresAt,
  }))
  if (need > 1e-6) {
    if (articleCostRef <= 0) {
      return {
        success: false,
        error: articleReferenceCostError(articleName),
        status: 400,
      }
    }
    incoming.push({
      qty: need,
      unitCost: articleCostRef,
      receivedAt: new Date().toISOString(),
      expiresAt: null,
    })
  }

  const { data: fromNameRow } = await supabase
    .from("inventory_locations")
    .select("name")
    .eq("id", from.locationId)
    .maybeSingle()
  const { data: toNameRow } = await supabase
    .from("inventory_locations")
    .select("name")
    .eq("id", to.locationId)
    .maybeSingle()
  const fromName = String(fromNameRow?.name ?? "origen")
  const toName = String(toNameRow?.name ?? "destino")
  const transferGroupId = randomUUID()
  const note = `Traslado — ${articleName} · ${fromName} → ${toName}`
  const outId = randomUUID()
  const inId = randomUUID()

  const ops: AuditOp[] = [
    {
      op: "insert",
      table: "inventory_movements",
      row: {
        id: outId,
        pop_id: popId,
        location_id: from.locationId,
        counterpart_location_id: to.locationId,
        transfer_group_id: transferGroupId,
        article_id: input.articleId,
        quantity_delta: -qtyAbs,
        movement_type: "transfer_out",
        note,
        created_by: userId,
      },
    },
  ]

  for (const take of takes) {
    ops.push({
      op: "insert",
      table: "inventory_layer_allocations",
      row: {
        id: randomUUID(),
        pop_id: popId,
        layer_id: take.layerId,
        article_id: input.articleId,
        inventory_movement_id: outId,
        quantity: take.qty,
        unit_cost: take.unitCost,
      },
    })
    ops.push({
      op: "update",
      table: "inventory_cost_layers",
      id: take.layerId,
      row: { quantity_remaining: parseQty(take.remainingBefore - take.qty) },
    })
  }

  ops.push({
    op: "insert",
    table: "inventory_movements",
    row: {
      id: inId,
      pop_id: popId,
      location_id: to.locationId,
      counterpart_location_id: from.locationId,
      transfer_group_id: transferGroupId,
      article_id: input.articleId,
      quantity_delta: qtyAbs,
      movement_type: "transfer_in",
      note,
      created_by: userId,
    },
  })

  let holeLeft = holeQty
  for (const slice of incoming) {
    let fromSlice = slice.qty
    if (holeLeft > 1e-6) {
      const cover = Math.min(fromSlice, holeLeft)
      ops.push({
        op: "insert",
        table: "inventory_cost_layers",
        row: {
          id: randomUUID(),
          pop_id: popId,
          location_id: to.locationId,
          article_id: input.articleId,
          source_movement_id: inId,
          quantity_received: cover,
          quantity_remaining: 0,
          unit_cost: slice.unitCost,
          received_at: slice.receivedAt,
          expires_at: slice.expiresAt,
        },
      })
      holeLeft = parseQty(holeLeft - cover)
      fromSlice = parseQty(fromSlice - cover)
    }
    if (fromSlice > 1e-6) {
      ops.push({
        op: "insert",
        table: "inventory_cost_layers",
        row: {
          id: randomUUID(),
          pop_id: popId,
          location_id: to.locationId,
          article_id: input.articleId,
          source_movement_id: inId,
          quantity_received: fromSlice,
          quantity_remaining: fromSlice,
          unit_cost: slice.unitCost,
          received_at: slice.receivedAt,
          expires_at: slice.expiresAt,
        },
      })
    }
  }

  const applied = await applyWithAudit(supabase, {
    kind: "inventory.transfer",
    ctx: audit,
    popId,
    resourceId: transferGroupId,
    previous: null,
    next: { from: from.locationId, to: to.locationId, quantity: qtyAbs },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
