import type { SupabaseClient } from "@supabase/supabase-js"
import { mapRoleRpcError } from "./schema.js"

type RpcOkJson = { ok?: boolean; error?: string; role_id?: string }

export async function getRoleEditor(
  supabase: SupabaseClient,
  popId: string,
  roleId: string,
): Promise<
  | {
      success: true
      data: {
        role: { id: string; displayName: string; name: string; canApprove: boolean }
        selectedGrantKeys: string[]
      }
    }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const { data: roleRow, error: roleErr } = await supabase
    .from("roles")
    .select("id, name, display_name, pop_id, permission_grants, can_approve")
    .eq("id", roleId)
    .single()

  if (roleErr || !roleRow) {
    return { success: false, error: "Rol no encontrado.", status: 404 }
  }
  if (roleRow.pop_id == null || String(roleRow.pop_id) !== String(popId)) {
    return {
      success: false,
      error:
        "Solo se pueden editar roles creados para este punto de venta (no los roles de sistema).",
      status: 400,
    }
  }

  const raw = roleRow.permission_grants
  const selectedGrantKeys = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : []

  return {
    success: true,
    data: {
      role: {
        id: String(roleRow.id),
        displayName: String(roleRow.display_name ?? ""),
        name: String(roleRow.name ?? ""),
        canApprove: roleRow.can_approve === true,
      },
      selectedGrantKeys,
    },
  }
}

export async function saveRolePermissions(
  supabase: SupabaseClient,
  popId: string,
  roleId: string,
  grantKeys: string[],
  canApprove: boolean,
): Promise<
  { success: true } | { success: false; error: string; status: 400 | 500 }
> {
  const keys = [...new Set(grantKeys.map((x) => x.trim()).filter(Boolean))]
  const { data, error } = await supabase.rpc("hr_pop_owner_sync_role_permissions", {
    p_pop_id: popId,
    p_role_id: roleId,
    p_permission_grants: keys,
    p_can_approve: canApprove,
  })

  if (error) return { success: false, error: error.message, status: 500 }
  const payload = data as RpcOkJson | null
  if (!payload?.ok) {
    return { success: false, error: mapRoleRpcError(payload?.error), status: 400 }
  }
  return { success: true }
}

export async function createRole(
  supabase: SupabaseClient,
  popId: string,
  displayName: string,
  grantKeys: string[],
  canApprove: boolean,
): Promise<
  | { success: true; roleId: string }
  | { success: false; error: string; status: 400 | 500 }
> {
  const keys = [...new Set(grantKeys.map((x) => x.trim()).filter(Boolean))]
  const { data, error } = await supabase.rpc("hr_pop_owner_create_pop_role", {
    p_pop_id: popId,
    p_display_name: displayName.trim(),
    p_permission_grants: keys,
    p_can_approve: canApprove,
  })

  if (error) return { success: false, error: error.message, status: 500 }
  const payload = data as RpcOkJson | null
  if (!payload?.ok || !payload.role_id) {
    return { success: false, error: mapRoleRpcError(payload?.error), status: 400 }
  }
  return { success: true, roleId: String(payload.role_id) }
}

export async function deleteRole(
  supabase: SupabaseClient,
  popId: string,
  roleId: string,
): Promise<
  { success: true } | { success: false; error: string; status: 400 | 500 }
> {
  const { data, error } = await supabase.rpc("hr_pop_owner_delete_pop_role", {
    p_pop_id: popId,
    p_role_id: roleId,
  })

  if (error) return { success: false, error: error.message, status: 500 }
  const payload = data as RpcOkJson | null
  if (!payload?.ok) {
    return { success: false, error: mapRoleRpcError(payload?.error), status: 400 }
  }
  return { success: true }
}
