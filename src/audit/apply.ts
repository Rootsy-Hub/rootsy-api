import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuditOp, MutationAuditCtx } from "./types.js"
import { snapshotState } from "./types.js"

type ApplyResult =
  | { success: true; id?: string }
  | { success: false; error: string; status: 400 | 404 | 500 }

type RpcOk = { ok?: boolean; error?: string; id?: string | null }

export async function applyWithAudit(
  supabase: SupabaseClient,
  input: {
    kind: string
    ctx: MutationAuditCtx
    popId: string
    resourceId?: string | null
    previous?: unknown
    next?: unknown
    ops: AuditOp[]
  },
): Promise<ApplyResult> {
  const states = snapshotState(input.ctx.action, input.previous ?? null, input.next ?? null)
  const { data, error } = await supabase.rpc("rootsy_apply_with_audit", {
    p_kind: input.kind,
    p_payload: { ops: input.ops },
    p_audit: {
      pop_id: input.popId,
      resource: input.ctx.resource,
      resource_id: input.resourceId ?? null,
      action: input.ctx.action,
      http_method: input.ctx.httpMethod,
      path: input.ctx.path,
      previous_state: states.previous_state,
      new_state: states.new_state,
      requester_user_id: input.ctx.requesterUserId,
      approver_user_id: input.ctx.approverUserId,
      execution_source: input.ctx.executionSource,
    },
  })
  if (error) {
    return { success: false, error: error.message || "No se pudo guardar.", status: 500 }
  }
  const payload = data as RpcOk | null
  if (!payload?.ok) {
    const err = payload?.error ?? "No se pudo guardar."
    const status = err === "not_found" ? 404 : err === "forbidden" ? 500 : 400
    return {
      success: false,
      error:
        err === "not_found"
          ? "No se encontró el registro."
          : err === "pop_mismatch" || err === "table_not_allowed"
            ? "Operación inválida."
            : err,
      status: status === 400 && err === "not_found" ? 404 : status,
    }
  }
  return {
    success: true,
    id: payload.id ? String(payload.id) : undefined,
  }
}

export async function verifyApprovalCode(
  supabase: SupabaseClient,
  popId: string,
  approverUserId: string,
  code: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("rootsy_verify_approval_code", {
    p_pop_id: popId,
    p_approver_user_id: approverUserId,
    p_code: code,
  })
  if (error) return false
  return data === true
}
