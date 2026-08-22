import type { SupabaseClient } from "@supabase/supabase-js"
import { parseBankStatementCsv } from "./csv.js"
import { parseMoney, roundMoney } from "../reports/money.js"

async function requireTreasuryAccount(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: 404 }> {
  const { data, error } = await supabase
    .from("treasury_accounts")
    .select("id")
    .eq("id", treasuryAccountId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (error || !data?.id) {
    return { ok: false, error: "Cuenta de tesorería inválida.", status: 404 }
  }
  return { ok: true }
}

export async function importBankStatementCsv(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  treasuryAccountId: string,
  csvText: string,
): Promise<
  | { success: true; imported: number; warnings: string[] }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const parsed = parseBankStatementCsv(csvText)
  if (parsed.lines.length === 0) {
    return {
      success: false,
      error:
        parsed.errors[0] ||
        "No se importó ninguna línea. Revisá el formato del CSV.",
      status: 400,
    }
  }
  const account = await requireTreasuryAccount(supabase, popId, treasuryAccountId)
  if (!account.ok) return { success: false, error: account.error, status: account.status }

  const rows = parsed.lines.map((line) => ({
    pop_id: popId,
    treasury_account_id: treasuryAccountId,
    line_date: line.lineDate,
    description: line.description,
    amount: line.amount,
    direction: line.direction,
    source: "csv" as const,
    created_by: userId,
  }))
  const { error } = await supabase.from("bank_statement_lines").insert(rows)
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo importar.",
      status: 500,
    }
  }
  return { success: true, imported: rows.length, warnings: parsed.errors }
}

export async function addManualBankStatementLine(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  treasuryAccountId: string,
  input: {
    lineDate: string
    description?: string
    amount: number
    direction: "in" | "out"
  },
): Promise<
  | { success: true; id: string }
  | { success: false; error: string; status: 400 | 404 | 500 }
> {
  const amt = roundMoney(parseMoney(input.amount))
  if (!(amt > 0)) {
    return {
      success: false,
      error: "El importe debe ser mayor a cero.",
      status: 400,
    }
  }
  const account = await requireTreasuryAccount(supabase, popId, treasuryAccountId)
  if (!account.ok) return { success: false, error: account.error, status: account.status }

  const { data, error } = await supabase
    .from("bank_statement_lines")
    .insert({
      pop_id: popId,
      treasury_account_id: treasuryAccountId,
      line_date: input.lineDate,
      description: input.description?.trim() || "Movimiento extracto",
      amount: amt,
      direction: input.direction,
      source: "manual",
      created_by: userId,
    })
    .select("id")
    .single()
  if (error || !data?.id) {
    return {
      success: false,
      error: error?.message || "No se pudo guardar.",
      status: 500,
    }
  }
  return { success: true, id: String(data.id) }
}

export async function deleteBankStatementLine(
  supabase: SupabaseClient,
  popId: string,
  treasuryAccountId: string,
  lineId: string,
): Promise<
  { success: true } | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error: readErr } = await supabase
    .from("bank_statement_lines")
    .select("id")
    .eq("id", lineId)
    .eq("pop_id", popId)
    .eq("treasury_account_id", treasuryAccountId)
    .maybeSingle()
  if (readErr) {
    return { success: false, error: readErr.message, status: 500 }
  }
  if (!data?.id) {
    return { success: false, error: "Línea de extracto no encontrada.", status: 404 }
  }
  const { error } = await supabase
    .from("bank_statement_lines")
    .delete()
    .eq("id", lineId)
    .eq("pop_id", popId)
    .eq("treasury_account_id", treasuryAccountId)
  if (error) {
    return {
      success: false,
      error: error.message || "No se pudo eliminar.",
      status: 500,
    }
  }
  return { success: true }
}
