import type { SupabaseClient } from "@supabase/supabase-js"
import { hasAnyPermission } from "../../sidecar/permissions.js"
import { ensureEmployeesFromMembers, listEmployees } from "./employees.js"
import { loadMembers, loadPendingInvites, loadRoles } from "./members.js"
import type { HrDashboardData } from "./schema.js"

export async function getHrDashboard(
  supabase: SupabaseClient,
  popId: string,
  keys: readonly string[],
  isOwner: boolean,
  inviteBaseUrl: string,
): Promise<
  | { success: true; data: HrDashboardData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: pop, error: popErr } = await supabase
    .from("pops")
    .select("name, owner_user_id")
    .eq("id", popId)
    .maybeSingle()

  if (popErr || !pop) {
    return { success: false, error: "POP no encontrado", status: 404 }
  }

  const ownerUserId =
    typeof pop.owner_user_id === "string" ? pop.owner_user_id : null

  const [rolesRes, membersRes] = await Promise.all([
    loadRoles(supabase, popId),
    loadMembers(supabase, popId, ownerUserId),
  ])
  if (!rolesRes.success) return rolesRes
  if (!membersRes.success) return membersRes

  await ensureEmployeesFromMembers(supabase, popId, membersRes.members)
  const peopleRes = await listEmployees(supabase, popId)
  if (!peopleRes.success) return peopleRes

  const pendingInvites = isOwner
    ? await loadPendingInvites(supabase, popId, inviteBaseUrl)
    : []

  return {
    success: true,
    data: {
      popName: String(pop.name ?? ""),
      isOwner,
      canManageInvites: isOwner,
      canManagePeople:
        isOwner || hasAnyPermission(keys, ["hr:create", "hr:update"], false),
      permissionKeys: [...keys],
      roles: rolesRes.roles,
      members: membersRes.members,
      employees: peopleRes.employees,
      pendingInvites,
    },
  }
}
