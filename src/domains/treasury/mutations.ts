import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  auditedDelete,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { isMotherRow, loadAllTreasuryAccounts } from "./accounts.js"
import {
  createTreasuryChartSubaccount,
  createTreasuryChartSubaccountUnderParent,
} from "./chartCreate.js"
import {
  isCardPayableChartCode,
  isMotherTreasuryAccount,
  isSettlementReceivableChartCode,
  parseTreasuryKind,
  TREASURY_CARD_PAYABLE_PARENT_CHART_CODE,
  TREASURY_POS_PARENT_CHART_CODE,
  type TreasuryAccountKind,
} from "./kinds.js"
import type {
  CreateTreasuryAccountBody,
  CreateTreasuryChildBody,
  UpdateTreasuryAccountBody,
} from "./schema.js"

type MutateResult =
  | { success: true }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

export async function createTreasuryAccount(
  supabase: SupabaseClient,
  popId: string,
  input: CreateTreasuryAccountBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const chart = await createTreasuryChartSubaccount(
    supabase,
    popId,
    input.kind,
    input.name,
  )
  if ("error" in chart) {
    return { success: false, error: chart.error, status: 400 }
  }

  const accountId = randomUUID()
  const applied = await applyWithAudit(supabase, {
    kind: "treasury.account.create",
    ctx: audit,
    popId,
    resourceId: accountId,
    previous: null,
    next: { id: accountId, name: input.name, kind: input.kind },
    ops: [
      { op: "insert", table: "accounting_chart_of_accounts", row: chart.row },
      {
        op: "insert",
        table: "treasury_accounts",
        row: {
          id: accountId,
          pop_id: popId,
          name: input.name,
          kind: input.kind,
          brand_key: input.brandKey?.trim() || null,
          accounting_chart_account_id: chart.id,
          is_system_default: false,
          is_active: true,
          sort_order: input.sortOrder,
        },
      },
    ],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function createTreasuryChildAccount(
  supabase: SupabaseClient,
  popId: string,
  parentTreasuryAccountId: string,
  input: CreateTreasuryChildBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: parent, error: parentErr } = await supabase
    .from("treasury_accounts")
    .select(
      `
      id,
      kind,
      sort_order,
      accounting_chart_of_accounts ( code )
    `,
    )
    .eq("id", parentTreasuryAccountId)
    .eq("pop_id", popId)
    .maybeSingle()

  if (parentErr || !parent?.id) {
    return { success: false, error: "Cuenta madre no encontrada.", status: 404 }
  }

  const parentKind = parseTreasuryKind(parent.kind)
  const parentChart = parent.accounting_chart_of_accounts as unknown as {
    code?: string
  } | null
  const parentChartCode = String(parentChart?.code ?? "")

  if (!isMotherTreasuryAccount(parentChartCode)) {
    return {
      success: false,
      error: "Solo se pueden agregar terminales o tarjetas a cuentas madre.",
      status: 400,
    }
  }
  if (parentKind !== "bank" && parentKind !== "wallet") {
    return {
      success: false,
      error:
        input.kind === "pos"
          ? "Los terminales POS se agregan a cuentas banco o billetera."
          : "Las tarjetas corporativas se agregan a cuentas banco o billetera.",
      status: 400,
    }
  }

  const { data: siblingRows } = await supabase
    .from("treasury_accounts")
    .select(
      `
      kind,
      accounting_chart_of_accounts ( code )
    `,
    )
    .eq("pop_id", popId)
    .eq("parent_treasury_account_id", parentTreasuryAccountId)

  for (const sibling of siblingRows || []) {
    const siblingChart = sibling.accounting_chart_of_accounts as unknown as {
      code?: string
    } | null
    const siblingCode = String(siblingChart?.code ?? "")
    const siblingKind = parseTreasuryKind(sibling.kind)
    if (
      input.kind === "pos" &&
      isSettlementReceivableChartCode(siblingCode)
    ) {
      return {
        success: false,
        error: "Esta cuenta ya tiene un terminal POS.",
        status: 409,
      }
    }
    if (
      input.kind === "card_payable" &&
      (siblingKind === "card_payable" || isCardPayableChartCode(siblingCode))
    ) {
      return {
        success: false,
        error: "Esta cuenta ya tiene una tarjeta corporativa.",
        status: 409,
      }
    }
  }

  const chartConfig =
    input.kind === "pos"
      ? {
          parentCode: TREASURY_POS_PARENT_CHART_CODE,
          treasuryKind: "other" as TreasuryAccountKind,
          accountType: "activo_corriente",
          nature: "deudora",
          kind: "other" as TreasuryAccountKind,
        }
      : {
          parentCode: TREASURY_CARD_PAYABLE_PARENT_CHART_CODE,
          treasuryKind: "card_payable" as TreasuryAccountKind,
          accountType: "pasivo_corriente",
          nature: "acreedora",
          kind: "card_payable" as TreasuryAccountKind,
        }

  const chart = await createTreasuryChartSubaccountUnderParent(
    supabase,
    popId,
    chartConfig.parentCode,
    input.name,
    {
      treasuryKind: chartConfig.treasuryKind,
      accountType: chartConfig.accountType,
      nature: chartConfig.nature,
    },
  )
  if ("error" in chart) {
    return { success: false, error: chart.error, status: 400 }
  }

  const parentSort = Number(parent.sort_order ?? 0)
  const accountId = randomUUID()
  const applied = await applyWithAudit(supabase, {
    kind: "treasury.child.create",
    ctx: audit,
    popId,
    resourceId: accountId,
    previous: null,
    next: { id: accountId, name: input.name, kind: chartConfig.kind },
    ops: [
      { op: "insert", table: "accounting_chart_of_accounts", row: chart.row },
      {
        op: "insert",
        table: "treasury_accounts",
        row: {
          id: accountId,
          pop_id: popId,
          name: input.name,
          kind: chartConfig.kind,
          accounting_chart_account_id: chart.id,
          parent_treasury_account_id: parentTreasuryAccountId,
          is_system_default: false,
          is_active: true,
          sort_order: Math.trunc(parentSort + (input.kind === "pos" ? 1 : 2)),
        },
      },
    ],
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function updateTreasuryAccount(
  supabase: SupabaseClient,
  popId: string,
  accountId: string,
  input: UpdateTreasuryAccountBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing } = await supabase
    .from("treasury_accounts")
    .select("id, name, accounting_chart_account_id")
    .eq("id", accountId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (!existing?.id) {
    return { success: false, error: "Cuenta no encontrada.", status: 404 }
  }

  const ops = [
    {
      op: "update" as const,
      table: "treasury_accounts",
      id: accountId,
      row: { name: input.name },
    },
  ]
  if (existing.accounting_chart_account_id) {
    ops.push({
      op: "update",
      table: "accounting_chart_of_accounts",
      id: String(existing.accounting_chart_account_id),
      row: { name: input.name },
    })
  }

  const applied = await applyWithAudit(supabase, {
    kind: "treasury.account.patch",
    ctx: audit,
    popId,
    resourceId: accountId,
    previous: existing,
    next: { ...existing, name: input.name },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function setTreasuryAccountActive(
  supabase: SupabaseClient,
  popId: string,
  accountId: string,
  isActive: boolean,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing } = await supabase
    .from("treasury_accounts")
    .select("id, is_active")
    .eq("id", accountId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (!existing?.id) {
    return { success: false, error: "Cuenta no encontrada.", status: 404 }
  }

  const applied = await auditedUpdate(supabase, {
    kind: "treasury.account.active",
    table: "treasury_accounts",
    id: accountId,
    row: { is_active: isActive },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, is_active: isActive },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function deleteTreasuryAccount(
  supabase: SupabaseClient,
  popId: string,
  accountId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const loaded = await loadAllTreasuryAccounts(supabase, popId)
  if (!loaded.success) {
    return { success: false, error: loaded.error, status: 500 }
  }
  const row = loaded.rows.find((item) => item.id === accountId)
  if (!row) {
    return { success: false, error: "Cuenta no encontrada.", status: 404 }
  }
  if (isMotherRow(row)) {
    const childCount = loaded.rows.filter(
      (item) => item.parentTreasuryAccountId === accountId,
    ).length
    if (childCount > 0) {
      return {
        success: false,
        error:
          "Hay terminales POS o tarjetas vinculados a esta cuenta. Eliminalos o reasignalos antes.",
        status: 409,
      }
    }
  }

  const applied = await auditedDelete(supabase, {
    kind: "treasury.account.delete",
    table: "treasury_accounts",
    id: accountId,
    ctx: audit,
    popId,
    previous: row,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
