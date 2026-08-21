import type { SupabaseClient } from "@supabase/supabase-js"

const DEFAULT_SITE_ID = "arg"
const MESAS_READ_KEY = "mesas:read"

export type PopAccessGate =
  | { ok: true; popSiteId: string }
  | { ok: false; error: string; redirect?: string; status: 403 | 404 }

function permissionRowToKey(row: unknown): string | null {
  if (row == null) return null
  if (typeof row === "string") {
    const t = row.trim()
    return t.includes(":") ? t : null
  }
  if (Array.isArray(row) && row.length >= 2) {
    const a = row[0]
    const b = row[1]
    if (typeof a === "string" && typeof b === "string") return `${a}:${b}`
  }
  if (typeof row === "object") {
    const o = row as Record<string, unknown>
    const r = o.resource ?? o.Resource
    const act = o.action ?? o.Action
    if (typeof r === "string" && typeof act === "string") return `${r}:${act}`
  }
  return null
}

function permissionRowsToKeys(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  const out: string[] = []
  for (const row of data) {
    const k = permissionRowToKey(row)
    if (k) out.push(k)
  }
  return out
}

function sameUserId(a: string, b: string): boolean {
  return (
    a.replace(/-/g, "").toLowerCase().trim() ===
    b.replace(/-/g, "").toLowerCase().trim()
  )
}

function siteIdFromPopRow(row: {
  site_id?: string | null
  settings?: unknown
}): string {
  const col = row.site_id
  if (typeof col === "string" && col.trim()) return col.trim()
  if (row.settings && typeof row.settings === "object") {
    const v = (row.settings as Record<string, unknown>).site_id
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return DEFAULT_SITE_ID
}

function siteIdsMatch(routeSiteId: string, popSiteId: string): boolean {
  return routeSiteId.trim().toLowerCase() === popSiteId.trim().toLowerCase()
}

export async function requireMesasLayoutAccess(
  supabase: SupabaseClient,
  userId: string,
  popId: string,
  routeSiteId: string,
): Promise<PopAccessGate> {
  const [{ data: hasAccess, error: accessError }, { data: isActive }] =
    await Promise.all([
      supabase.rpc("user_has_pop_access", {
        pop_id: popId,
        user_id: userId,
      }),
      supabase.rpc("is_pop_active", { pop_id: popId }),
    ])

  if (accessError || !hasAccess) {
    return {
      ok: false,
      status: 403,
      error: "Sin acceso al punto de venta",
      redirect: "/home",
    }
  }

  if (isActive !== true) {
    return {
      ok: false,
      status: 403,
      error: "Este POP no está activo.",
      redirect: "/home",
    }
  }

  const { data: pop, error: popError } = await supabase
    .from("pops")
    .select("site_id, settings, owner_user_id")
    .eq("id", popId)
    .maybeSingle()

  if (popError || !pop) {
    return { ok: false, status: 404, error: "POP no encontrado" }
  }

  const popSiteId = siteIdFromPopRow({
    site_id: pop.site_id as string | null | undefined,
    settings: pop.settings,
  })

  if (!siteIdsMatch(routeSiteId, popSiteId)) {
    return {
      ok: false,
      status: 403,
      error: "Ruta inválida para este punto de venta",
      redirect: `/${popSiteId}/${popId}/menu`,
    }
  }

  const { data: permRows } = await supabase.rpc("get_user_all_permissions", {
    p_pop_id: popId,
    p_user_id: userId,
  })
  const keys = permissionRowsToKeys(permRows)
  const isOwner =
    typeof pop.owner_user_id === "string" &&
    sameUserId(pop.owner_user_id, userId)

  if (!keys.includes(MESAS_READ_KEY) && !isOwner) {
    return {
      ok: false,
      status: 403,
      error: "Sin permiso para esta acción en Mesas.",
    }
  }

  return { ok: true, popSiteId }
}
