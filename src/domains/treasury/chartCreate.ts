import type { SupabaseClient } from "@supabase/supabase-js"
import {
  TREASURY_KIND_PARENT_CHART_CODE,
  type TreasuryAccountKind,
} from "./kinds.js"

type ChartRow = {
  id: string
  code: string
  name: string
  account_type: string
  nature: string
  level: number
}

function nextChildCode(parentCode: string, siblings: string[]): string {
  const prefix = `${parentCode}.`
  let max = 0
  for (const code of siblings) {
    if (!code.startsWith(prefix)) continue
    const tail = code.slice(prefix.length)
    const n = Number.parseInt(tail.split(".")[0] ?? "", 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${parentCode}.${String(max + 1).padStart(2, "0")}`
}

export async function createTreasuryChartSubaccountUnderParent(
  supabase: SupabaseClient,
  popId: string,
  parentChartCode: string,
  accountName: string,
  options: {
    treasuryKind: TreasuryAccountKind
    accountType: string
    nature: string
  },
): Promise<{ id: string; code: string } | { error: string }> {
  const name = accountName.trim()
  if (!name) return { error: "El nombre de la cuenta es obligatorio." }

  const { data: parent, error: parentErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id, code, level")
    .eq("pop_id", popId)
    .eq("code", parentChartCode)
    .maybeSingle()

  if (parentErr || !parent?.id) {
    return {
      error: `No se encontró la cuenta padre ${parentChartCode} en el plan de cuentas.`,
    }
  }

  const parentRow = parent as Pick<ChartRow, "id" | "code" | "level">
  const { data: siblings, error: sibErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select("code")
    .eq("pop_id", popId)
    .like("code", `${parentRow.code}.%`)

  if (sibErr) {
    return { error: sibErr.message || "No se pudieron listar subcuentas." }
  }

  const codes = (siblings ?? []).map((row) => String(row.code ?? ""))
  const newCode = nextChildCode(parentRow.code, codes)
  const level = Math.max(1, (parentRow.level ?? 4) + 1)

  const { data: inserted, error: insErr } = await supabase
    .from("accounting_chart_of_accounts")
    .insert({
      pop_id: popId,
      parent_id: parentRow.id,
      code: newCode,
      name,
      account_type: options.accountType,
      nature: options.nature,
      level,
      is_movement_account: true,
      metadata: { user_created: true, treasury_kind: options.treasuryKind },
    })
    .select("id, code")
    .single()

  if (insErr || !inserted?.id) {
    return {
      error: insErr?.message || "No se pudo crear la subcuenta contable.",
    }
  }
  return { id: String(inserted.id), code: String(inserted.code) }
}

export async function createTreasuryChartSubaccount(
  supabase: SupabaseClient,
  popId: string,
  kind: TreasuryAccountKind,
  accountName: string,
): Promise<{ id: string; code: string } | { error: string }> {
  const name = accountName.trim()
  if (!name) return { error: "El nombre de la cuenta es obligatorio." }

  const parentCode = TREASURY_KIND_PARENT_CHART_CODE[kind]
  const { data: parent, error: parentErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id, code, account_type, nature, level")
    .eq("pop_id", popId)
    .eq("code", parentCode)
    .maybeSingle()

  if (parentErr || !parent?.id) {
    return {
      error: `No se encontró la cuenta padre ${parentCode} en el plan de cuentas.`,
    }
  }

  const parentRow = parent as ChartRow
  const { data: siblings, error: sibErr } = await supabase
    .from("accounting_chart_of_accounts")
    .select("code")
    .eq("pop_id", popId)
    .like("code", `${parentRow.code}.%`)

  if (sibErr) {
    return { error: sibErr.message || "No se pudieron listar subcuentas." }
  }

  const codes = (siblings ?? []).map((row) => String(row.code ?? ""))
  const newCode = nextChildCode(parentRow.code, codes)
  const level = Math.max(1, (parentRow.level ?? 4) + 1)
  const accountType =
    kind === "card_payable" || kind === "check_payable"
      ? "pasivo_corriente"
      : "activo_corriente"
  const nature =
    kind === "card_payable" || kind === "check_payable" ? "acreedora" : "deudora"

  const { data: inserted, error: insErr } = await supabase
    .from("accounting_chart_of_accounts")
    .insert({
      pop_id: popId,
      parent_id: parentRow.id,
      code: newCode,
      name,
      account_type: accountType,
      nature,
      level,
      is_movement_account: true,
      metadata: { user_created: true, treasury_kind: kind },
    })
    .select("id, code")
    .single()

  if (insErr || !inserted?.id) {
    return {
      error: insErr?.message || "No se pudo crear la subcuenta contable.",
    }
  }
  return { id: String(inserted.id), code: String(inserted.code) }
}
