import type { SupabaseClient } from "@supabase/supabase-js"
import { parseInventoryExpiresAt } from "./expiry.js"
import { parseQty } from "./qty.js"
import type { SetExpiryBody } from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 500 }

export async function setInventoryLayerExpiry(
  supabase: SupabaseClient,
  popId: string,
  layerId: string,
  input: SetExpiryBody,
): Promise<MutateResult> {
  const expiresAt = parseInventoryExpiresAt(input.expiresAt)
  const id = layerId.trim()
  if (!id) {
    return { success: false, error: "Falta la capa.", status: 400 }
  }

  const { data: layer, error: layerErr } = await supabase
    .from("inventory_cost_layers")
    .select(
      "id, pop_id, location_id, article_id, source_movement_id, quantity_received, quantity_remaining, unit_cost, received_at, expires_at",
    )
    .eq("id", id)
    .eq("pop_id", popId)
    .maybeSingle()
  if (layerErr || !layer) {
    return {
      success: false,
      error: layerErr?.message || "No se encontró la capa.",
      status: 404,
    }
  }

  const remaining = parseQty(layer.quantity_remaining)
  if (remaining <= 1e-6) {
    return { success: false, error: "Esa capa ya no tiene stock.", status: 400 }
  }

  const received = parseQty(layer.quantity_received)
  const qtyRaw = input.quantity == null ? remaining : parseQty(input.quantity)
  if (qtyRaw <= 1e-6) {
    return {
      success: false,
      error: "Indicá una cantidad mayor que cero.",
      status: 400,
    }
  }
  if (qtyRaw > remaining + 1e-6) {
    return { success: false, error: "No hay tanta cantidad en esa capa.", status: 400 }
  }

  const dateUnchanged = parseInventoryExpiresAt(layer.expires_at) === expiresAt
  if (dateUnchanged && qtyRaw >= remaining - 1e-6) {
    return { success: true }
  }

  if (qtyRaw >= remaining - 1e-6) {
    const { error } = await supabase
      .from("inventory_cost_layers")
      .update({ expires_at: expiresAt })
      .eq("id", id)
      .eq("pop_id", popId)
    if (error) {
      return {
        success: false,
        error: error.message || "No se pudo guardar la fecha.",
        status: 500,
      }
    }
    return { success: true }
  }

  const leftover = parseQty(remaining - qtyRaw)
  const receivedAfter = parseQty(received - qtyRaw)
  if (receivedAfter + 1e-9 < leftover) {
    return { success: false, error: "No se puede partir esa capa.", status: 400 }
  }

  const { error: shrinkErr } = await supabase
    .from("inventory_cost_layers")
    .update({
      quantity_remaining: leftover,
      quantity_received: receivedAfter,
    })
    .eq("id", id)
    .eq("pop_id", popId)
  if (shrinkErr) {
    return {
      success: false,
      error: shrinkErr.message || "No se pudo partir la capa.",
      status: 500,
    }
  }

  const { error: insertErr } = await supabase.from("inventory_cost_layers").insert({
    pop_id: popId,
    location_id: layer.location_id,
    article_id: layer.article_id,
    source_movement_id: layer.source_movement_id,
    quantity_received: qtyRaw,
    quantity_remaining: qtyRaw,
    unit_cost: layer.unit_cost,
    received_at: layer.received_at,
    expires_at: expiresAt,
  })
  if (insertErr) {
    await supabase
      .from("inventory_cost_layers")
      .update({
        quantity_remaining: remaining,
        quantity_received: received,
      })
      .eq("id", id)
      .eq("pop_id", popId)
    return {
      success: false,
      error: insertErr.message || "No se pudo crear el lote partido.",
      status: 500,
    }
  }

  return { success: true }
}
