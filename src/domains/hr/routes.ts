import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { hasAnyPermission, requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { HR_READ, HR_WRITE } from "./allowlist.js"
import {
  getClockStation,
  rotateClockStationPin,
  unlockClockStation,
} from "./clockStation.js"
import {
  clockEmployeeByPin,
  clockEmployeeIn,
  clockEmployeeOut,
  getEmployeeDetail,
  markEmployeeFranco,
  markEmployeeLeft,
  markEmployeeReturned,
  removeEmployeeFranco,
  rotateEmployeeClockPin,
  updateEmployee,
  upsertEmployee,
} from "./employees.js"
import { loadHrPaymentContext, recordEmployeePayment } from "./payments.js"
import { getHrDashboard } from "./hub.js"
import {
  createInvitation,
  deactivateMember,
  deleteInactiveMember,
  reactivateMember,
  renewInvitation,
  revokeInvitation,
  updateMemberRole,
} from "./members.js"
import { createRole, deleteRole, getRoleEditor, saveRolePermissions } from "./roles.js"
import {
  clockByPinBodySchema,
  createRoleBodySchema,
  francoBodySchema,
  inviteBodySchema,
  recordEmployeePaymentBodySchema,
  memberRoleBodySchema,
  roleGrantsBodySchema,
  upsertEmployeeBodySchema,
} from "./schema.js"
import { parsePatchBody } from "../../lib/patchBody.js"

const idSchema = z.string().uuid()

export const hrRoutes = new Hono<SidecarEnv>()

function bodyError(issues: { message: string }[]) {
  return {
    success: false as const,
    error: issues[0]?.message ?? "Body inválido",
  }
}

hrRoutes.get("/", async (c) => {
  const sidecar = c.get("sidecar")
  if (!hasAnyPermission(sidecar.keys, HR_READ, sidecar.isOwner)) {
    return c.json(
      {
        success: false,
        error:
          "No tenés permiso para ver Recursos humanos en este punto de venta.",
        redirect: `/${sidecar.popSiteId}/${sidecar.popId}`,
      },
      403,
    )
  }
  const inviteBaseUrl = c.req.query("inviteBaseUrl")?.trim() ?? ""
  const result = await getHrDashboard(
    c.get("supabase"),
    sidecar.popId,
    sidecar.keys,
    sidecar.isOwner,
    inviteBaseUrl,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

hrRoutes.get(
  "/employees/:employeeId",
  requireAnyPermission(HR_READ),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getEmployeeDetail(
      c.get("supabase"),
      sidecar.popId,
      employeeId.data,
      sidecar.keys,
      sidecar.isOwner,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.post(
  "/employees",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const body = upsertEmployeeBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await upsertEmployee(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json({ success: true, data: { id: result.id } }, 201)
  },
)

hrRoutes.patch(
  "/employees/:employeeId",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const body = parsePatchBody(
      upsertEmployeeBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json({ success: false, error: body.error }, 400)
    const { id: _ignored, ...patch } = body.data
    const result = await updateEmployee(
      c.get("supabase"),
      c.get("sidecar").popId,
      employeeId.data,
      patch,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json({ success: true, data: { id: result.id } })
  },
)

hrRoutes.post(
  "/employees/:employeeId/left",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const result = await markEmployeeLeft(
      c.get("supabase"),
      c.get("sidecar").popId,
      employeeId.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.post(
  "/employees/:employeeId/returned",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const result = await markEmployeeReturned(
      c.get("supabase"),
      c.get("sidecar").popId,
      employeeId.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.post(
  "/employees/:employeeId/clock-in",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await clockEmployeeIn(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      employeeId.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.get("/clock-station", requireAnyPermission(HR_READ), async (c) => {
  const sidecar = c.get("sidecar")
  const result = await getClockStation(
    c.get("supabase"),
    sidecar.popId,
    sidecar.keys,
    sidecar.isOwner,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json({ success: true, data: result.data })
})

hrRoutes.post(
  "/clock-station/unlock",
  requireAnyPermission(HR_READ),
  async (c) => {
    const body = clockByPinBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await unlockClockStation(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data.pin,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.post(
  "/clock-station/pin",
  requireAnyPermission(HR_WRITE),
  async (c) => {
    const result = await rotateClockStationPin(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json({
      success: true,
      data: { clockStationPin: result.clockStationPin },
    })
  },
)

hrRoutes.post(
  "/clock",
  requireAnyPermission(HR_READ),
  async (c) => {
    const body = clockByPinBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const sidecar = c.get("sidecar")
    const result = await clockEmployeeByPin(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      body.data.pin,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json({
      success: true,
      data: {
        action: result.action,
        firstName: result.firstName,
        lastName: result.lastName,
      },
    })
  },
)

hrRoutes.post(
  "/employees/:employeeId/clock-pin",
  requireAnyPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const result = await rotateEmployeeClockPin(
      c.get("supabase"),
      c.get("sidecar").popId,
      employeeId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json({ success: true, data: { clockPin: result.clockPin } })
  },
)

hrRoutes.post(
  "/employees/:employeeId/clock-out",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const result = await clockEmployeeOut(
      c.get("supabase"),
      c.get("sidecar").popId,
      employeeId.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.post(
  "/employees/:employeeId/francos",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const body = francoBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const sidecar = c.get("sidecar")
    const result = await markEmployeeFranco(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      employeeId.data,
      body.data.day,
      body.data.kind,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.get(
  "/payment-context",
  requireAnyPermission(HR_WRITE),
  async (c) => {
    const result = await loadHrPaymentContext(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

hrRoutes.post(
  "/employees/:employeeId/payments",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    if (!employeeId.success) {
      return c.json({ success: false, error: "Persona inválida" }, 400)
    }
    const body = recordEmployeePaymentBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await recordEmployeePayment(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      employeeId.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

hrRoutes.delete(
  "/employees/:employeeId/francos/:francoId",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const employeeId = idSchema.safeParse(c.req.param("employeeId"))
    const francoId = idSchema.safeParse(c.req.param("francoId"))
    if (!employeeId.success || !francoId.success) {
      return c.json({ success: false, error: "Identificador inválido" }, 400)
    }
    const result = await removeEmployeeFranco(
      c.get("supabase"),
      c.get("sidecar").popId,
      employeeId.data,
      francoId.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.post("/invitations", requireMutationPermission(HR_WRITE), async (c) => {
  const body = inviteBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const result = await createInvitation(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    null,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(
    {
      success: true,
      data: {
        inviteUrl: result.inviteUrl,
        email: result.email,
        popName: result.popName,
      },
    },
    201,
  )
})

hrRoutes.post(
  "/invitations/:invitationId/revoke",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const invitationId = idSchema.safeParse(c.req.param("invitationId"))
    if (!invitationId.success) {
      return c.json({ success: false, error: "Invitación inválida" }, 400)
    }
    const result = await revokeInvitation(
      c.get("supabase"),
      c.get("sidecar").popId,
      invitationId.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

hrRoutes.post(
  "/invitations/:invitationId/renew",
  requireMutationPermission(HR_WRITE),
  async (c) => {
    const invitationId = idSchema.safeParse(c.req.param("invitationId"))
    if (!invitationId.success) {
      return c.json({ success: false, error: "Invitación inválida" }, 400)
    }
    const body = z
      .object({ inviteBaseUrl: z.string().url().optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    const result = await renewInvitation(
      c.get("supabase"),
      c.get("sidecar").popId,
      invitationId.data,
      c.get("mutationAudit"),
      body.success ? body.data.inviteBaseUrl : undefined,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json({ success: true, data: { inviteUrl: result.inviteUrl } })
  },
)

hrRoutes.patch("/members/:userId/role", requireMutationPermission(HR_WRITE), async (c) => {
  const userId = idSchema.safeParse(c.req.param("userId"))
  if (!userId.success) {
    return c.json({ success: false, error: "Miembro inválido" }, 400)
  }
  const body = memberRoleBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const { data: pop } = await c
    .get("supabase")
    .from("pops")
    .select("owner_user_id")
    .eq("id", c.get("sidecar").popId)
    .maybeSingle()
  const result = await updateMemberRole(
    c.get("supabase"),
    c.get("sidecar").popId,
    typeof pop?.owner_user_id === "string" ? pop.owner_user_id : null,
    userId.data,
    body.data.roleId,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

hrRoutes.post("/members/:userId/deactivate", requireMutationPermission(HR_WRITE), async (c) => {
  const userId = idSchema.safeParse(c.req.param("userId"))
  if (!userId.success) {
    return c.json({ success: false, error: "Miembro inválido" }, 400)
  }
  const { data: pop } = await c
    .get("supabase")
    .from("pops")
    .select("owner_user_id")
    .eq("id", c.get("sidecar").popId)
    .maybeSingle()
  const result = await deactivateMember(
    c.get("supabase"),
    c.get("sidecar").popId,
    typeof pop?.owner_user_id === "string" ? pop.owner_user_id : null,
    userId.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

hrRoutes.post("/members/:userId/reactivate", requireMutationPermission(HR_WRITE), async (c) => {
  const userId = idSchema.safeParse(c.req.param("userId"))
  if (!userId.success) {
    return c.json({ success: false, error: "Miembro inválido" }, 400)
  }
  const { data: pop } = await c
    .get("supabase")
    .from("pops")
    .select("owner_user_id")
    .eq("id", c.get("sidecar").popId)
    .maybeSingle()
  const result = await reactivateMember(
    c.get("supabase"),
    c.get("sidecar").popId,
    typeof pop?.owner_user_id === "string" ? pop.owner_user_id : null,
    userId.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

hrRoutes.delete("/members/:userId", requireMutationPermission(HR_WRITE), async (c) => {
  const userId = idSchema.safeParse(c.req.param("userId"))
  if (!userId.success) {
    return c.json({ success: false, error: "Miembro inválido" }, 400)
  }
  const { data: pop } = await c
    .get("supabase")
    .from("pops")
    .select("owner_user_id")
    .eq("id", c.get("sidecar").popId)
    .maybeSingle()
  const result = await deleteInactiveMember(
    c.get("supabase"),
    c.get("sidecar").popId,
    typeof pop?.owner_user_id === "string" ? pop.owner_user_id : null,
    userId.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

hrRoutes.get("/roles/:roleId", requireAnyPermission(HR_WRITE), async (c) => {
  const roleId = idSchema.safeParse(c.req.param("roleId"))
  if (!roleId.success) {
    return c.json({ success: false, error: "Rol inválido" }, 400)
  }
  const result = await getRoleEditor(
    c.get("supabase"),
    c.get("sidecar").popId,
    roleId.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

hrRoutes.post("/roles", requireMutationPermission(HR_WRITE), async (c) => {
  const body = createRoleBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const result = await createRole(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data.displayName,
    body.data.grantKeys,
    body.data.canApprove,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json({ success: true, data: { roleId: result.roleId } }, 201)
})

hrRoutes.patch("/roles/:roleId", requireMutationPermission(HR_WRITE), async (c) => {
  const roleId = idSchema.safeParse(c.req.param("roleId"))
  if (!roleId.success) {
    return c.json({ success: false, error: "Rol inválido" }, 400)
  }
  const body = roleGrantsBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const result = await saveRolePermissions(
    c.get("supabase"),
    c.get("sidecar").popId,
    roleId.data,
    body.data.grantKeys,
    body.data.canApprove,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

hrRoutes.delete("/roles/:roleId", requireMutationPermission(HR_WRITE), async (c) => {
  const roleId = idSchema.safeParse(c.req.param("roleId"))
  if (!roleId.success) {
    return c.json({ success: false, error: "Rol inválido" }, 400)
  }
  const result = await deleteRole(
    c.get("supabase"),
    c.get("sidecar").popId,
    roleId.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})
