import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AuditOp } from "./types.js"

export type LedgerLineOp = {
  account_id: string
  debit_amount: number
  credit_amount: number
  description: string
  line_order: number
}

export async function nextAccountingEntryNumber(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data: maxRow } = await supabase
    .from("accounting_entries")
    .select("entry_number")
    .eq("pop_id", popId)
    .order("entry_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  return maxRow?.entry_number != null && Number.isFinite(Number(maxRow.entry_number))
    ? Number(maxRow.entry_number) + 1
    : 1
}

export function postedAccountingEntryOps(input: {
  popId: string
  userId: string
  entryNumber: number
  entryDate: string
  sourceType: string
  sourceId: string
  description: string
  lines: LedgerLineOp[]
  entryId?: string
}): { entryId: string; ops: AuditOp[] } {
  const entryId = input.entryId ?? randomUUID()
  const postedAt = new Date().toISOString()
  const ops: AuditOp[] = [
    {
      op: "insert",
      table: "accounting_entries",
      row: {
        id: entryId,
        pop_id: input.popId,
        entry_number: input.entryNumber,
        entry_date: input.entryDate,
        source_type: input.sourceType,
        source_id: input.sourceId,
        description: input.description,
        status: "posted",
        created_by: input.userId,
        posted_at: postedAt,
        posted_by: input.userId,
      },
    },
  ]
  for (const line of input.lines) {
    ops.push({
      op: "insert",
      table: "accounting_entry_lines",
      row: {
        id: randomUUID(),
        entry_id: entryId,
        account_id: line.account_id,
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
        description: line.description,
        line_order: line.line_order,
      },
    })
  }
  return { entryId, ops }
}
