import type { SupabaseClient } from "@supabase/supabase-js"
import { sameUserId } from "./ids.js"
import type { MemberRow, PendingInviteRow, PopRoleRow } from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 403 | 404 | 409 | 500 }

function asRoleRel(raw: unknown): { name?: string; display_name?: string } | null {
  if (!raw) return null
  const row = Array.isArray(raw) ? raw[0] : raw
  if (!row || typeof row !== "object") return null
  return row as { name?: string; display_name?: string }
}

export async function loadRoles(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; roles: PopRoleRow[] }
  | { success: false; error: string; status: 500 }
> {
  const { data: roleRows, error } = await supabase
    .from("roles")
    .select("id, name, display_name, description, is_system, pop_id")
    .or(`pop_id.is.null,pop_id.eq.${popId}`)
    .order("display_name")

  if (error) return { success: false, error: error.message, status: 500 }

  return {
    success: true,
    roles: (roleRows || []).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      displayName: String(r.display_name ?? ""),
      description: r.description ?? null,
      isSystem: Boolean(r.is_system),
      popId: r.pop_id != null ? String(r.pop_id) : null,
    })),
  }
}

export async function loadMembers(
  supabase: SupabaseClient,
  popId: string,
  ownerUserId: string | null,
): Promise<
  | { success: true; members: MemberRow[] }
  | { success: false; error: string; status: 500 }
> {
  const { data: uprRows, error: uprErr } = await supabase
    .from("user_pop_roles")
    .select(
      `
      user_id,
      role_id,
      invited_at,
      is_active,
      roles:role_id ( name, display_name )
    `,
    )
    .eq("pop_id", popId)

  if (uprErr) return { success: false, error: uprErr.message, status: 500 }

  const userIds = [...new Set((uprRows || []).map((r) => String(r.user_id)))]
  const profileMap: Record<
    string,
    { first_name: string; last_name: string; image_url: string | null }
  > = {}
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("users")
      .select("id, first_name, last_name, image_url")
      .in("id", userIds)
    for (const p of profiles || []) {
      profileMap[String(p.id)] = {
        first_name: p.first_name ?? "",
        last_name: p.last_name ?? "",
        image_url: p.image_url ?? null,
      }
    }
  }

  let ownerProfile = {
    first_name: "",
    last_name: "",
    image_url: null as string | null,
  }
  if (ownerUserId && !userIds.includes(ownerUserId)) {
    const { data: op } = await supabase
      .from("users")
      .select("first_name, last_name, image_url")
      .eq("id", ownerUserId)
      .maybeSingle()
    if (op) {
      ownerProfile = {
        first_name: op.first_name ?? "",
        last_name: op.last_name ?? "",
        image_url: op.image_url ?? null,
      }
    }
  }

  const members: MemberRow[] = (uprRows || []).map((row) => {
    const rel = asRoleRel(row.roles)
    const prof = profileMap[String(row.user_id)] || {
      first_name: "",
      last_name: "",
      image_url: null,
    }
    return {
      userId: String(row.user_id),
      roleId: String(row.role_id ?? ""),
      roleDisplayName: rel?.display_name ?? "—",
      roleName: rel?.name ?? "",
      firstName: prof.first_name,
      lastName: prof.last_name,
      imageUrl: prof.image_url,
      invitedAt: row.invited_at ?? null,
      isOwner: ownerUserId ? sameUserId(String(row.user_id), ownerUserId) : false,
      isActive: row.is_active !== false,
    }
  })

  if (ownerUserId && !members.some((m) => sameUserId(m.userId, ownerUserId))) {
    members.unshift({
      userId: ownerUserId,
      roleId: "",
      roleDisplayName: "Propietario",
      roleName: "owner",
      firstName: ownerProfile.first_name,
      lastName: ownerProfile.last_name,
      imageUrl: ownerProfile.image_url,
      invitedAt: null,
      isOwner: true,
      isActive: true,
    })
  }

  return { success: true, members }
}

export async function loadPendingInvites(
  supabase: SupabaseClient,
  popId: string,
  inviteBaseUrl: string,
): Promise<PendingInviteRow[]> {
  const { data: inv, error } = await supabase
    .from("pop_invitations")
    .select(
      `
      id,
      email,
      employee_id,
      role_id,
      message,
      created_at,
      expires_at,
      token,
      roles:role_id ( display_name )
    `,
    )
    .eq("pop_id", popId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })

  if (error || !inv) return []

  const base = inviteBaseUrl.replace(/\/$/, "")
  return inv.map((i) => {
    const rr = asRoleRel(i.roles)
    return {
      id: String(i.id),
      email: String(i.email ?? ""),
      employeeId: i.employee_id ? String(i.employee_id) : null,
      roleId: String(i.role_id ?? ""),
      roleDisplayName: rr?.display_name ?? "—",
      message: i.message ?? null,
      createdAt: String(i.created_at ?? ""),
      expiresAt: String(i.expires_at ?? ""),
      inviteUrl: i.token ? `${base}/invite/pop/${i.token}` : "",
    }
  })
}

export async function createInvitation(
  supabase: SupabaseClient,
  popId: string,
  invitedBy: string,
  invitedByEmail: string | null,
  input: {
    employeeId: string
    roleId: string
    message?: string | null
    inviteBaseUrl?: string
  },
): Promise<
  | { success: true; inviteUrl: string; email: string; popName: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }
> {
  const { data: pop, error: popErr } = await supabase
    .from("pops")
    .select("name")
    .eq("id", popId)
    .maybeSingle()
  if (popErr || !pop) {
    return { success: false, error: "POP no encontrado", status: 404 }
  }

  const { data: employee, error: employeeErr } = await supabase
    .from("pop_employees")
    .select("id, email, user_id, left_at")
    .eq("pop_id", popId)
    .eq("id", input.employeeId)
    .maybeSingle()

  if (employeeErr) return { success: false, error: employeeErr.message, status: 500 }
  if (!employee) {
    return { success: false, error: "No encontramos a esa persona.", status: 404 }
  }
  if (employee.left_at) {
    return {
      success: false,
      error: "Esa persona ya no trabaja en este local.",
      status: 400,
    }
  }
  if (employee.user_id) {
    return { success: false, error: "Esa persona ya entra a Rootsy.", status: 400 }
  }

  const email = String(employee.email || "").trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      success: false,
      error: "Cargá el correo en la ficha antes de dar acceso.",
      status: 400,
    }
  }

  if (invitedByEmail && invitedByEmail.trim().toLowerCase() === email) {
    return { success: false, error: "No podés invitarte a vos mismo.", status: 400 }
  }

  const { data: inviteeId } = await supabase.rpc(
    "lookup_auth_user_id_for_pop_owner_invite",
    { p_pop_id: popId, p_email: email },
  )

  if (inviteeId && sameUserId(invitedBy, String(inviteeId))) {
    return { success: false, error: "No podés invitarte a vos mismo.", status: 400 }
  }

  const { data: roleRow, error: roleErr } = await supabase
    .from("roles")
    .select("id, name, pop_id")
    .eq("id", input.roleId)
    .single()

  if (roleErr || !roleRow) {
    return { success: false, error: "Rol no válido.", status: 400 }
  }
  if (roleRow.name === "owner") {
    return {
      success: false,
      error: "No se puede asignar el rol Propietario por invitación.",
      status: 400,
    }
  }
  if (roleRow.pop_id != null && String(roleRow.pop_id) !== String(popId)) {
    return { success: false, error: "Ese rol no pertenece a este POP.", status: 400 }
  }

  if (inviteeId) {
    const { data: existingMember } = await supabase
      .from("user_pop_roles")
      .select("id")
      .eq("pop_id", popId)
      .eq("user_id", inviteeId)
      .eq("is_active", true)
      .maybeSingle()

    if (existingMember) {
      return {
        success: false,
        error: "Ese usuario ya es miembro activo de este punto de venta.",
        status: 409,
      }
    }
  }

  const { data: inserted, error: insErr } = await supabase
    .from("pop_invitations")
    .insert({
      pop_id: popId,
      email,
      employee_id: input.employeeId,
      role_id: input.roleId,
      invited_by: invitedBy,
      message: input.message?.trim() || null,
    })
    .select("token")
    .single()

  if (insErr) {
    if (insErr.code === "23505") {
      return {
        success: false,
        error: "Ya hay una invitación pendiente para esa persona.",
        status: 409,
      }
    }
    return { success: false, error: insErr.message, status: 500 }
  }

  const base = (input.inviteBaseUrl || "").replace(/\/$/, "")
  return {
    success: true,
    inviteUrl: inserted.token && base ? `${base}/invite/pop/${inserted.token}` : "",
    email,
    popName: String(pop.name ?? ""),
  }
}

export async function revokeInvitation(
  supabase: SupabaseClient,
  popId: string,
  invitationId: string,
): Promise<MutateResult> {
  const { error } = await supabase
    .from("pop_invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId)
    .eq("pop_id", popId)
    .eq("status", "pending")
  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}

export async function renewInvitation(
  supabase: SupabaseClient,
  popId: string,
  invitationId: string,
  inviteBaseUrl?: string,
): Promise<
  | { success: true; inviteUrl: string }
  | { success: false; error: string; status: 404 | 500 }
> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from("pop_invitations")
    .update({ expires_at: expiresAt })
    .eq("id", invitationId)
    .eq("pop_id", popId)
    .eq("status", "pending")
    .select("token")
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "No encontramos esa invitación.", status: 404 }
  }
  const base = (inviteBaseUrl || "").replace(/\/$/, "")
  return {
    success: true,
    inviteUrl: data.token && base ? `${base}/invite/pop/${data.token}` : "",
  }
}

export async function deactivateMember(
  supabase: SupabaseClient,
  popId: string,
  ownerUserId: string | null,
  memberUserId: string,
): Promise<MutateResult> {
  if (ownerUserId && sameUserId(memberUserId, ownerUserId)) {
    return {
      success: false,
      error: "No se puede quitar al propietario del POP.",
      status: 400,
    }
  }

  const { error } = await supabase
    .from("user_pop_roles")
    .update({ is_active: false })
    .eq("pop_id", popId)
    .eq("user_id", memberUserId)

  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}

export async function updateMemberRole(
  supabase: SupabaseClient,
  popId: string,
  ownerUserId: string | null,
  memberUserId: string,
  roleId: string,
): Promise<MutateResult> {
  if (ownerUserId && sameUserId(memberUserId, ownerUserId)) {
    return {
      success: false,
      error: "El rol del dueño no se cambia desde acá.",
      status: 400,
    }
  }

  const { data: roleRow, error: roleErr } = await supabase
    .from("roles")
    .select("id, name, pop_id")
    .eq("id", roleId)
    .single()

  if (roleErr || !roleRow) {
    return { success: false, error: "Rol no válido.", status: 400 }
  }
  if (roleRow.name === "owner") {
    return { success: false, error: "No se puede asignar el rol de dueño.", status: 400 }
  }
  if (roleRow.pop_id != null && String(roleRow.pop_id) !== String(popId)) {
    return { success: false, error: "Ese rol no pertenece a este local.", status: 400 }
  }

  const { data: membership, error: memberErr } = await supabase
    .from("user_pop_roles")
    .select("id, role_id")
    .eq("pop_id", popId)
    .eq("user_id", memberUserId)
    .eq("is_active", true)
    .maybeSingle()

  if (memberErr) return { success: false, error: memberErr.message, status: 500 }
  if (!membership) {
    return {
      success: false,
      error: "Esa persona no tiene acceso activo a Rootsy.",
      status: 404,
    }
  }
  if (membership.role_id === roleId) return { success: true }

  const { error } = await supabase
    .from("user_pop_roles")
    .update({ role_id: roleId })
    .eq("id", membership.id)

  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}

export async function deleteInactiveMember(
  supabase: SupabaseClient,
  popId: string,
  ownerUserId: string | null,
  memberUserId: string,
): Promise<MutateResult> {
  if (ownerUserId && sameUserId(memberUserId, ownerUserId)) {
    return {
      success: false,
      error: "No se puede eliminar al propietario del POP.",
      status: 400,
    }
  }

  const { error } = await supabase
    .from("user_pop_roles")
    .delete()
    .eq("pop_id", popId)
    .eq("user_id", memberUserId)
    .eq("is_active", false)

  if (error) return { success: false, error: error.message, status: 500 }
  return { success: true }
}
