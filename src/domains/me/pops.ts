import type { SupabaseClient } from "@supabase/supabase-js"
import { permissionRowsToKeys } from "../../sidecar/pop.js"
import type { MePop, MePopSubscription } from "./schema.js"

const DEFAULT_SITE_ID = "arg"

const POP_SELECT =
  "id, name, image_url, background_image_url, street_address, is_active, owner_user_id, site_id, settings"

const MAX_DOCK_ITEMS = 8

type PopRow = {
  id: string
  name: string
  image_url: string | null
  background_image_url: string | null
  street_address: string | null
  is_active: boolean
  owner_user_id: string
  site_id: string | null
  settings: unknown
}

type MemberRoleRow = {
  pop_id: string
  roles:
    | { name: string; display_name: string; pop_id: string | null }
    | { name: string; display_name: string; pop_id: string | null }[]
    | null
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

function roleMatchesPop(
  rolePopId: string | null | undefined,
  membershipPopId: string,
): boolean {
  if (rolePopId == null) return true
  return String(rolePopId) === String(membershipPopId)
}

function parseDockItemIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const id = entry === "active-services" ? "operations" : String(entry ?? "")
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_DOCK_ITEMS) break
  }
  return out
}

function mapSubscription(raw: Record<string, unknown>): MePopSubscription {
  return {
    isActive: Boolean(raw.is_active),
    status: String(raw.status ?? ""),
    planDisplayName: String(raw.plan_display_name ?? ""),
    daysRemaining:
      raw.days_remaining != null ? Number(raw.days_remaining) : null,
    businessTypeName: String(raw.business_type_name ?? ""),
    allModules: Boolean(raw.all_modules),
  }
}

async function loadUserPopIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const [{ data: ownedRows }, { data: memberRows }] = await Promise.all([
    supabase.from("pops").select("id").eq("owner_user_id", userId),
    supabase
      .from("user_pop_roles")
      .select("pop_id")
      .eq("user_id", userId)
      .eq("is_active", true),
  ])

  const ids = new Set<string>()
  for (const row of ownedRows ?? []) ids.add(String(row.id))
  for (const row of memberRows ?? []) ids.add(String(row.pop_id))
  return Array.from(ids)
}

export async function listMyPops(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ success: true; data: MePop[] } | { success: false; error: string }> {
  const popIds = await loadUserPopIds(supabase, userId)
  if (popIds.length === 0) return { success: true, data: [] }

  const [
    { data: popRows, error: popError },
    { data: memberRows, error: roleError },
    { data: dockRows },
  ] = await Promise.all([
    supabase.from("pops").select(POP_SELECT).in("id", popIds),
    supabase
      .from("user_pop_roles")
      .select("pop_id, roles:role_id ( name, display_name, pop_id )")
      .eq("user_id", userId)
      .in("pop_id", popIds)
      .eq("is_active", true),
    supabase
      .from("pop_user_menu_dock_preferences")
      .select("pop_id, dock_item_ids")
      .eq("user_id", userId)
      .in("pop_id", popIds),
  ])

  if (popError) return { success: false, error: popError.message }
  if (roleError) return { success: false, error: roleError.message }

  const dockByPopId = new Map<string, string[]>()
  for (const row of dockRows ?? []) {
    dockByPopId.set(String(row.pop_id), parseDockItemIds(row.dock_item_ids))
  }

  const roleNameByPopId = new Map<string, string>()
  for (const row of (memberRows ?? []) as MemberRoleRow[]) {
    const popId = String(row.pop_id)
    const roleRaw = Array.isArray(row.roles) ? row.roles[0] : row.roles
    if (!roleRaw || !roleMatchesPop(roleRaw.pop_id, popId)) continue
    const display = String(roleRaw.display_name ?? roleRaw.name ?? "").trim()
    if (display) roleNameByPopId.set(popId, display)
  }

  const pops = (popRows ?? []) as PopRow[]
  const withExtra = await Promise.all(
    pops.map(async (pop) => {
      const [subRes, permRes] = await Promise.all([
        supabase.rpc("get_pop_subscription_info", { pop_id: pop.id }),
        supabase.rpc("get_user_all_permissions", {
          p_pop_id: pop.id,
          p_user_id: userId,
        }),
      ])
      return { pop, subRes, permRes }
    }),
  )

  const out: MePop[] = []
  for (const { pop, subRes, permRes } of withExtra) {
    if (subRes.error || !subRes.data || subRes.data.length === 0) continue
    const isOwner = sameUserId(String(pop.owner_user_id), userId)
    const memberRole = roleNameByPopId.get(String(pop.id))
    if (!isOwner && !memberRole) continue

    const subscription = mapSubscription(subRes.data[0] as Record<string, unknown>)
    const isActive = Boolean(pop.is_active)
    out.push({
      id: String(pop.id),
      siteId: siteIdFromPopRow(pop),
      name: String(pop.name ?? "").trim(),
      imageUrl: pop.image_url ?? null,
      backgroundImageUrl:
        pop.background_image_url != null
          ? String(pop.background_image_url).trim() || null
          : null,
      streetAddress:
        pop.street_address != null
          ? String(pop.street_address).trim() || null
          : null,
      isOwner,
      roleName: isOwner ? "Dueño" : memberRole || "Miembro",
      isActive,
      canEnter: isActive && subscription.isActive,
      permissions: permissionRowsToKeys(permRes.data).sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
      dockItemIds: dockByPopId.get(String(pop.id)) ?? [],
      subscription,
    })
  }

  out.sort((a, b) => a.name.localeCompare(b.name, "es"))
  return { success: true, data: out }
}
