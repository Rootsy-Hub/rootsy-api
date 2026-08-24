import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "./apply.js"
import type { AuditOp, MutationAuditCtx } from "./types.js"

type Result =
  | { success: true; id?: string }
  | { success: false; error: string; status: 400 | 404 | 500 }

export async function auditedInsert(
  supabase: SupabaseClient,
  input: {
    kind: string
    table: string
    row: Record<string, unknown>
    ctx: MutationAuditCtx
    popId: string
    next?: unknown
  },
): Promise<Result> {
  const ops: AuditOp[] = [{ op: "insert", table: input.table, row: input.row }]
  return applyWithAudit(supabase, {
    kind: input.kind,
    ctx: input.ctx,
    popId: input.popId,
    resourceId: typeof input.row.id === "string" ? input.row.id : null,
    previous: null,
    next: input.next ?? input.row,
    ops,
  })
}

export async function auditedUpdate(
  supabase: SupabaseClient,
  input: {
    kind: string
    table: string
    id: string
    row: Record<string, unknown>
    ctx: MutationAuditCtx
    popId: string
    previous?: unknown
    next?: unknown
  },
): Promise<Result> {
  return applyWithAudit(supabase, {
    kind: input.kind,
    ctx: input.ctx,
    popId: input.popId,
    resourceId: input.id,
    previous: input.previous ?? null,
    next: input.next ?? input.row,
    ops: [{ op: "update", table: input.table, id: input.id, row: input.row }],
  })
}

export async function auditedDelete(
  supabase: SupabaseClient,
  input: {
    kind: string
    table: string
    id: string
    ctx: MutationAuditCtx
    popId: string
    previous?: unknown
  },
): Promise<Result> {
  return applyWithAudit(supabase, {
    kind: input.kind,
    ctx: input.ctx,
    popId: input.popId,
    resourceId: input.id,
    previous: input.previous ?? null,
    next: null,
    ops: [{ op: "delete", table: input.table, id: input.id }],
  })
}
