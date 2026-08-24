import type { Context } from "hono"
import type { MiddlewareHandler } from "hono"
import type { SupabaseClient } from "@supabase/supabase-js"
import { verifyApprovalCode } from "../audit/apply.js"
import {
  ROOTSY_AI_EXECUTION_HEADER,
  verifyRootsyAiExecution,
} from "../audit/hmac.js"
import {
  requestApprovalKeys,
  resourceActionFromAllowlist,
  type MutationAuditCtx,
} from "../audit/types.js"
import { hasAnyPermission } from "./permissions.js"
import { permissionRowsToKeys, type SidecarEnv } from "./pop.js"

const APPROVER_HEADER = "x-rootsy-approver-user-id"
const CODE_HEADER = "x-rootsy-approval-code"

function auditActionFromMethod(
  method: string,
  fallback: MutationAuditCtx["action"],
): MutationAuditCtx["action"] {
  const m = method.toUpperCase()
  if (m === "POST") return "create"
  if (m === "DELETE") return "delete"
  if (m === "PATCH") return "update"
  return fallback
}

export function requireMutationPermission(
  executeAllowlist: readonly string[],
): MiddlewareHandler<SidecarEnv> {
  const requestKeys = requestApprovalKeys(executeAllowlist)
  const inferred = resourceActionFromAllowlist(executeAllowlist)

  return async (c, next) => {
    const sidecar = c.get("sidecar")
    if (!sidecar) {
      return c.json({ success: false, error: "Sidecar ausente" }, 500)
    }

    const userId = c.get("userId")
    const method = c.req.method
    const path = new URL(c.req.url).pathname
    const isAi = verifyRootsyAiExecution({
      header: c.req.header(ROOTSY_AI_EXECUTION_HEADER),
      userId,
      popId: sidecar.popId,
      method,
      path,
    })

    const hasExecute = hasAnyPermission(
      sidecar.keys,
      executeAllowlist,
      sidecar.isOwner,
    )

    const ctxBase: Omit<MutationAuditCtx, "executionSource" | "approverUserId"> = {
      requesterUserId: userId,
      resource: inferred.resource,
      action: auditActionFromMethod(method, inferred.action),
      httpMethod: method,
      path,
    }

    if (isAi) {
      if (!hasExecute) {
        return c.json({ success: false, error: "Sin permiso" }, 403)
      }
      c.set("mutationAudit", {
        ...ctxBase,
        executionSource: "rootsy_ai",
        approverUserId: userId,
      })
      await next()
      return
    }

    if (hasExecute) {
      c.set("mutationAudit", {
        ...ctxBase,
        executionSource: "user",
        approverUserId: null,
      })
      await next()
      return
    }

    if (!hasAnyPermission(sidecar.keys, requestKeys, false)) {
      return c.json({ success: false, error: "Sin permiso" }, 403)
    }

    const approverId = c.req.header(APPROVER_HEADER)?.trim() ?? ""
    const code = c.req.header(CODE_HEADER)?.trim() ?? ""
    if (!approverId || !code) {
      return c.json(
        {
          success: false,
          error: "Esta acción requiere el código de un aprobador.",
        },
        403,
      )
    }

    const ok = await verifyApprovalCode(
      c.get("supabase"),
      sidecar.popId,
      approverId,
      code,
    )
    if (!ok) {
      return c.json({ success: false, error: "Código de aprobación inválido." }, 403)
    }

    const approverOk = await approverHasExecute(
      c,
      sidecar.popId,
      approverId,
      executeAllowlist,
    )
    if (!approverOk) {
      return c.json(
        {
          success: false,
          error: "Quien aprueba no tiene permiso para esta acción.",
        },
        403,
      )
    }

    c.set("mutationAudit", {
      ...ctxBase,
      executionSource: "user",
      approverUserId: approverId,
    })
    await next()
  }
}

async function approverHasExecute(
  c: Context<SidecarEnv>,
  popId: string,
  approverId: string,
  executeAllowlist: readonly string[],
): Promise<boolean> {
  const supabase = c.get("supabase") as SupabaseClient
  const { data: pop } = await supabase
    .from("pops")
    .select("owner_user_id")
    .eq("id", popId)
    .maybeSingle()
  const ownerId =
    pop && typeof pop.owner_user_id === "string" ? pop.owner_user_id : ""
  if (
    ownerId.replace(/-/g, "").toLowerCase() ===
    approverId.replace(/-/g, "").toLowerCase()
  ) {
    return true
  }

  const { data: permRows } = await supabase.rpc("get_user_all_permissions", {
    p_pop_id: popId,
    p_user_id: approverId,
  })
  const keys = permissionRowsToKeys(permRows)
  return executeAllowlist.some((key) => keys.includes(key))
}

export type { MutationAuditCtx }
