import type { SupabaseClient } from "@supabase/supabase-js"

export async function loadPriceListOverrideMap(
  supabase: SupabaseClient,
  popId: string,
  priceListId: string | null | undefined,
  itemKind: "article" | "recipe",
  itemIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const unique = [...new Set(itemIds.filter(Boolean))]
  if (!priceListId || unique.length === 0) return map

  const { data: list } = await supabase
    .from("price_lists")
    .select("id, is_default")
    .eq("id", priceListId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (!list?.id || list.is_default) return map

  const { data } = await supabase
    .from("price_list_items")
    .select("item_id, amount")
    .eq("pop_id", popId)
    .eq("price_list_id", priceListId)
    .eq("item_kind", itemKind)
    .in("item_id", unique)

  for (const row of data ?? []) {
    const amount = Number(row.amount)
    if (Number.isFinite(amount)) {
      map.set(String(row.item_id), amount)
    }
  }
  return map
}
