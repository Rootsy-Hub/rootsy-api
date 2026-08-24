import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import { auditedDelete } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import type { ReconciliationMarkBody } from "./schema.js"

export async function setMovementReconciliation(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  treasuryAccountId: string,
  input: ReconciliationMarkBody,
  audit: MutationAuditCtx,
): Promise<
  { success: true } | { success: false; error: string; status: 400 | 404 | 500 }
> {
  let stmtId = input.statementLineId?.trim() || null
  if (stmtId) {
    const { data: stmtRow, error: stmtErr } = await supabase
      .from("bank_statement_lines")
      .select("id")
      .eq("id", stmtId)
      .eq("pop_id", popId)
      .eq("treasury_account_id", treasuryAccountId)
      .maybeSingle()
    if (stmtErr || !stmtRow) {
      return { success: false, error: "Línea de extracto inválida.", status: 400 }
    }
  }

  const { data: existing } = await supabase
    .from("treasury_reconciliation_marks")
    .select("id")
    .eq("pop_id", popId)
    .eq("movement_kind", input.movementKind)
    .eq("movement_ref_id", input.movementRefId)
    .maybeSingle()

  const now = new Date().toISOString()
  const row = {
    pop_id: popId,
    treasury_account_id: treasuryAccountId,
    movement_kind: input.movementKind,
    movement_ref_id: input.movementRefId,
    statement_line_id: stmtId,
    reconciled_at: now,
    reconciled_by: userId,
  }

  const applied = existing?.id
    ? await applyWithAudit(supabase, {
        kind: "treasury.mark.set",
        ctx: audit,
        popId,
        resourceId: String(existing.id),
        previous: existing,
        next: row,
        ops: [
          {
            op: "update",
            table: "treasury_reconciliation_marks",
            id: String(existing.id),
            row,
          },
        ],
      })
    : await applyWithAudit(supabase, {
        kind: "treasury.mark.set",
        ctx: audit,
        popId,
        resourceId: undefined,
        previous: null,
        next: row,
        ops: [
          {
            op: "insert",
            table: "treasury_reconciliation_marks",
            row: { id: randomUUID(), ...row },
          },
        ],
      })

  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function clearMovementReconciliation(
  supabase: SupabaseClient,
  popId: string,
  movementKind: string,
  movementRefId: string,
  audit: MutationAuditCtx,
): Promise<{ success: true } | { success: false; error: string; status: 400 | 404 | 500 }> {
  const { data: existing, error: lookErr } = await supabase
    .from("treasury_reconciliation_marks")
    .select("id")
    .eq("pop_id", popId)
    .eq("movement_kind", movementKind)
    .eq("movement_ref_id", movementRefId)
    .maybeSingle()
  if (lookErr) {
    return {
      success: false,
      error: lookErr.message || "No se pudo desmarcar.",
      status: 500,
    }
  }
  if (!existing?.id) return { success: true }

  const applied = await auditedDelete(supabase, {
    kind: "treasury.mark.clear",
    table: "treasury_reconciliation_marks",
    id: String(existing.id),
    ctx: audit,
    popId,
    previous: existing,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
