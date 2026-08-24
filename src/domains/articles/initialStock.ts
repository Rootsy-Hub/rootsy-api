import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
} from "../../audit/ledgerOps.js"
import type { AuditOp } from "../../audit/types.js"

const INITIAL_STOCK_NOTE = "Saldo inicial"
const CHART_MERCADERIAS_CODES = ["1.1.3.01", "1.1.3.02", "1.1.3.03"] as const
const CHART_INVENTARIO_INICIAL_PATRIMONIO_CODES = ["3.2.1.02", "3.2.1.01"] as const

const COUNTRY_TO_IANA: Record<string, string> = {
  AR: "America/Argentina/Buenos_Aires",
  CL: "America/Santiago",
  UY: "America/Montevideo",
  PY: "America/Asuncion",
  BO: "America/La_Paz",
  BR: "America/Sao_Paulo",
  CO: "America/Bogota",
  EC: "America/Guayaquil",
  PE: "America/Lima",
  VE: "America/Caracas",
  MX: "America/Mexico_City",
  US: "America/New_York",
  CA: "America/Toronto",
  ES: "Europe/Madrid",
}

function timezoneForPopLedger(
  country: string | null | undefined,
  siteId: string,
): string {
  const c = country?.trim().toUpperCase()
  if (c && COUNTRY_TO_IANA[c]) return COUNTRY_TO_IANA[c]
  if (siteId.trim().toLowerCase() === "arg") {
    return "America/Argentina/Buenos_Aires"
  }
  return "UTC"
}

function entryDateIsoInTimezone(timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date())
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

async function ensureDefaultLocation(
  supabase: SupabaseClient,
  popId: string,
): Promise<{ ok: true; locationId: string } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc(
    "ensure_pop_inventory_default_location",
    { p_pop_id: popId },
  )
  if (error || data == null || String(data).trim() === "") {
    return {
      ok: false,
      error: error?.message || "No se pudo resolver el depósito Despensa.",
    }
  }
  return { ok: true, locationId: String(data) }
}

export async function buildInitialStockLedgerOps(
  supabase: SupabaseClient,
  input: {
    popId: string
    popSiteId: string
    userId: string
    articleId: string
    articleName: string
    quantity: number
    unitCostSaleUom: number
  },
): Promise<{ ok: true; ops: AuditOp[] } | { ok: false; error: string }> {
  const qtyAbs = Number(input.quantity)
  if (!Number.isFinite(qtyAbs) || !Number.isInteger(qtyAbs) || qtyAbs < 1 || qtyAbs > 10000) {
    return {
      ok: false,
      error: "La cantidad de stock inicial debe ser un entero entre 1 y 10000.",
    }
  }
  const articleCostRef = roundMoney(Number(input.unitCostSaleUom))
  if (articleCostRef <= 0) {
    return {
      ok: false,
      error:
        "Indicá un costo de compra con precio mayor que cero para valorar el stock inicial.",
    }
  }
  const amount = roundMoney(qtyAbs * articleCostRef)
  if (amount <= 0) {
    return { ok: false, error: "El importe del asiento debe ser mayor que cero." }
  }

  const { data: pop } = await supabase
    .from("pops")
    .select("country, site_id")
    .eq("id", input.popId)
    .maybeSingle()
  const tz = timezoneForPopLedger(
    typeof pop?.country === "string" ? pop.country : null,
    input.popSiteId,
  )
  const entryDate = entryDateIsoInTimezone(tz)

  const location = await ensureDefaultLocation(supabase, input.popId)
  if (!location.ok) return { ok: false, error: location.error }

  async function resolveAccountId(codes: readonly string[]) {
    for (const code of codes) {
      const { data: row } = await supabase
        .from("accounting_chart_of_accounts")
        .select("id")
        .eq("pop_id", input.popId)
        .eq("code", code)
        .maybeSingle()
      if (row?.id) return String(row.id)
    }
    return null
  }

  const mercaderiasId = await resolveAccountId(CHART_MERCADERIAS_CODES)
  if (!mercaderiasId) {
    return {
      ok: false,
      error:
        "No hay cuenta de inventario (p. ej. 1.1.3.01 Mercaderías) en el plan de cuentas de este punto.",
    }
  }
  const offsetId = await resolveAccountId(CHART_INVENTARIO_INICIAL_PATRIMONIO_CODES)
  if (!offsetId) {
    return {
      ok: false,
      error:
        "No hay cuenta de patrimonio para stock inicial (p. ej. 3.2.1.02 Ajuste por inventario inicial).",
    }
  }

  const movementId = randomUUID()
  const nextNum = await nextAccountingEntryNumber(supabase, input.popId)
  const articleName = input.articleName.trim() || "Artículo"
  const { ops: entryOps } = postedAccountingEntryOps({
    popId: input.popId,
    userId: input.userId,
    entryNumber: nextNum,
    entryDate,
    sourceType: "inventory_initial",
    sourceId: movementId,
    description: `Stock inicial — ${articleName}`,
    lines: [
      {
        account_id: mercaderiasId,
        debit_amount: amount,
        credit_amount: 0,
        description: INITIAL_STOCK_NOTE,
        line_order: 1,
      },
      {
        account_id: offsetId,
        debit_amount: 0,
        credit_amount: amount,
        description: INITIAL_STOCK_NOTE,
        line_order: 2,
      },
    ],
  })

  return {
    ok: true,
    ops: [
      {
        op: "insert",
        table: "inventory_movements",
        row: {
          id: movementId,
          pop_id: input.popId,
          location_id: location.locationId,
          article_id: input.articleId,
          quantity_delta: qtyAbs,
          movement_type: "initial",
          note: INITIAL_STOCK_NOTE,
          created_by: input.userId,
        },
      },
      {
        op: "insert",
        table: "inventory_cost_layers",
        row: {
          id: randomUUID(),
          pop_id: input.popId,
          location_id: location.locationId,
          article_id: input.articleId,
          source_movement_id: movementId,
          quantity_received: qtyAbs,
          quantity_remaining: qtyAbs,
          unit_cost: articleCostRef,
          expires_at: null,
        },
      },
      ...entryOps,
    ],
  }
}
