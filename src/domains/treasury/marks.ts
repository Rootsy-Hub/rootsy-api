import type { SupabaseClient } from "@supabase/supabase-js"
import type { ReconciliationMarkBody } from "./schema.js"

export async function setMovementReconciliation(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  treasuryAccountId: string,
  input: ReconciliationMarkBody,
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

  const { error } = await supabase.from("treasury_reconciliation_marks").upsert(
    {
      pop_id: popId,
      treasury_account_id: treasuryAccountId,
      movement_kind: input.movementKind,
      movement_ref_id: input.movementRefId,
      statement_line_id: stmtId,
      reconciled_at: new Date().toISOString(),
      reconciled_by: userId,
    },
    { onConflict: "pop_id,movement_kind,movement_ref_id" },
  )
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo marcar como conciliado.",
      status: 500,
    }
  }
  return { success: true }
}

export async function clearMovementReconciliation(
  supabase: SupabaseClient,
  popId: string,
  movementKind: string,
  movementRefId: string,
): Promise<{ success: true } | { success: false; error: string; status: 500 }> {
  const { error } = await supabase
    .from("treasury_reconciliation_marks")
    .delete()
    .eq("pop_id", popId)
    .eq("movement_kind", movementKind)
    .eq("movement_ref_id", movementRefId)
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo desmarcar.",
      status: 500,
    }
  }
  return { success: true }
}
