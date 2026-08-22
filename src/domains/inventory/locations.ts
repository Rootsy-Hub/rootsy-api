import type { SupabaseClient } from "@supabase/supabase-js"
import type { InventoryLocationRow } from "./schema.js"
import { parseQty } from "./qty.js"

export function buildInventoryLocationRows(input: {
  locations: Array<{
    id: string
    name: string
    is_default: boolean
    is_sellable: boolean
  }>
  onHandByKey: Map<string, number>
  remainingValueByLocation: Map<string, number>
}): InventoryLocationRow[] {
  return input.locations.map((loc) => {
    let articleCount = 0
    let absOnHand = 0
    for (const [key, qty] of input.onHandByKey) {
      if (!key.startsWith(`${loc.id}:`)) continue
      if (qty > 1e-6) {
        articleCount += 1
      }
      if (Math.abs(qty) > 1e-6) {
        absOnHand += Math.abs(qty)
      }
    }
    const inventoryValue =
      Math.round((input.remainingValueByLocation.get(loc.id) ?? 0) * 100) / 100
    return {
      id: loc.id,
      name: loc.name,
      isDefault: Boolean(loc.is_default),
      isSellable: Boolean(loc.is_sellable),
      articleCount,
      inventoryValue,
      canArchive: !loc.is_default && absOnHand < 1e-6 && inventoryValue < 1e-6,
    }
  })
}

type LocationIdResult =
  | { success: true; locationId: string }
  | { success: false; error: string }

export async function ensurePopDefaultInventoryLocationId(
  supabase: SupabaseClient,
  popId: string,
): Promise<LocationIdResult> {
  const { data, error } = await supabase.rpc(
    "ensure_pop_inventory_default_location",
    { p_pop_id: popId },
  )
  if (error || data == null || String(data).trim() === "") {
    return {
      success: false,
      error: error?.message || "No se pudo resolver el depósito Despensa.",
    }
  }
  return { success: true, locationId: String(data) }
}

export async function resolvePopInventoryLocationId(
  supabase: SupabaseClient,
  popId: string,
  locationId: string,
): Promise<LocationIdResult> {
  const trimmed = locationId.trim()
  if (!trimmed) {
    return { success: false, error: "Elegí un depósito." }
  }
  const { data, error } = await supabase
    .from("inventory_locations")
    .select("id")
    .eq("pop_id", popId)
    .eq("id", trimmed)
    .is("archived_at", null)
    .maybeSingle()
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo leer el depósito.",
    }
  }
  if (!data?.id) {
    return { success: false, error: "Ese depósito no está disponible." }
  }
  return { success: true, locationId: String(data.id) }
}

export async function sumInventoryOnHandForArticle(
  supabase: SupabaseClient,
  popId: string,
  articleId: string,
  locationId?: string,
): Promise<
  { success: true; onHand: number } | { success: false; error: string }
> {
  let query = supabase
    .from("inventory_on_hand")
    .select("quantity")
    .eq("pop_id", popId)
    .eq("article_id", articleId)
  if (locationId) {
    query = query.eq("location_id", locationId)
  }
  const { data: rows, error } = await query
  if (error) {
    return { success: false, error: error.message || "No se pudo leer el stock." }
  }
  let t = 0
  for (const r of rows || []) {
    t += parseQty(r.quantity)
  }
  return { success: true, onHand: Math.round(t * 1e6) / 1e6 }
}
