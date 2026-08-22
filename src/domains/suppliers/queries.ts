import type { SupabaseClient } from "@supabase/supabase-js"
import { SUPPLIER_SEARCH_LIMIT, type SupplierOption } from "./schema.js"

type SupplierDbRow = {
  id: string
  name: string | null
}

function mapRow(row: SupplierDbRow): SupplierOption {
  return {
    id: String(row.id),
    name: String(row.name ?? "").trim(),
  }
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function buildSearchOrClause(raw: string): string | null {
  const t = raw.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  return `name.ilike.${pattern},tax_id.ilike.${pattern}`
}

export async function listSupplierOptions(
  supabase: SupabaseClient,
  popId: string,
  filters: { q?: string } = {},
): Promise<
  { success: true; data: SupplierOption[] } | { success: false; error: string }
> {
  const q = filters.q?.trim() ?? ""
  const orClause = q ? buildSearchOrClause(q) : null
  if (q && !orClause) {
    return { success: true, data: [] }
  }

  let query = supabase
    .from("suppliers")
    .select("id, name")
    .eq("pop_id", popId)
    .eq("is_active", true)
    .order("name", { ascending: true })

  if (orClause) {
    query = query.or(orClause).limit(SUPPLIER_SEARCH_LIMIT)
  }

  const { data, error } = await query
  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: (data ?? []).map((row) => mapRow(row as SupplierDbRow)),
  }
}
