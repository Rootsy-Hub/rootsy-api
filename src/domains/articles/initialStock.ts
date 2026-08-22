import type { SupabaseClient } from "@supabase/supabase-js"

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

export async function createInitialStockLedger(
  supabase: SupabaseClient,
  input: {
    popId: string
    popSiteId: string
    userId: string
    articleId: string
    quantity: number
    unitCostSaleUom: number
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const qtyAbs = Number(input.quantity)
  if (!Number.isFinite(qtyAbs) || !Number.isInteger(qtyAbs) || qtyAbs < 1 || qtyAbs > 10000) {
    return {
      success: false,
      error: "La cantidad de stock inicial debe ser un entero entre 1 y 10000.",
    }
  }
  const articleCostRef = roundMoney(Number(input.unitCostSaleUom))
  if (articleCostRef <= 0) {
    return {
      success: false,
      error:
        "Indicá un costo de compra con precio mayor que cero para valorar el stock inicial.",
    }
  }
  const amount = roundMoney(qtyAbs * articleCostRef)
  if (amount <= 0) {
    return { success: false, error: "El importe del asiento debe ser mayor que cero." }
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
  if (!location.ok) return { success: false, error: location.error }

  const { data: artRow, error: artErr } = await supabase
    .from("articles")
    .select("id, name")
    .eq("id", input.articleId)
    .eq("pop_id", input.popId)
    .maybeSingle()
  if (artErr || !artRow) {
    return { success: false, error: "Artículo no encontrado en este punto." }
  }

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
      success: false,
      error:
        "No hay cuenta de inventario (p. ej. 1.1.3.01 Mercaderías) en el plan de cuentas de este punto.",
    }
  }
  const offsetId = await resolveAccountId(CHART_INVENTARIO_INICIAL_PATRIMONIO_CODES)
  if (!offsetId) {
    return {
      success: false,
      error:
        "No hay cuenta de patrimonio para stock inicial (p. ej. 3.2.1.02 Ajuste por inventario inicial).",
    }
  }

  const { data: movIns, error: movErr } = await supabase
    .from("inventory_movements")
    .insert({
      pop_id: input.popId,
      location_id: location.locationId,
      article_id: input.articleId,
      quantity_delta: qtyAbs,
      movement_type: "initial",
      note: INITIAL_STOCK_NOTE,
      created_by: input.userId,
    })
    .select("id")
    .single()
  if (movErr || !movIns?.id) {
    return { success: false, error: movErr?.message || "No se pudo guardar el movimiento." }
  }
  const movementId = String(movIns.id)

  async function undoAfterMovementFailure() {
    await supabase.from("inventory_cost_layers").delete().eq("source_movement_id", movementId)
    await supabase.from("inventory_movements").delete().eq("id", movementId)
  }

  const { error: posLayerErr } = await supabase.from("inventory_cost_layers").insert({
    pop_id: input.popId,
    location_id: location.locationId,
    article_id: input.articleId,
    source_movement_id: movementId,
    quantity_received: qtyAbs,
    quantity_remaining: qtyAbs,
    unit_cost: articleCostRef,
    expires_at: null,
  })
  if (posLayerErr) {
    await undoAfterMovementFailure()
    return {
      success: false,
      error: posLayerErr.message || "No se pudo registrar la capa de costo del stock inicial.",
    }
  }

  const { data: maxRow } = await supabase
    .from("accounting_entries")
    .select("entry_number")
    .eq("pop_id", input.popId)
    .order("entry_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextNum =
    maxRow?.entry_number != null && Number.isFinite(Number(maxRow.entry_number))
      ? Number(maxRow.entry_number) + 1
      : 1

  const { data: entIns, error: entErr } = await supabase
    .from("accounting_entries")
    .insert({
      pop_id: input.popId,
      entry_number: nextNum,
      entry_date: entryDate,
      source_type: "inventory_initial",
      source_id: movementId,
      description: `Stock inicial — ${String(artRow.name ?? "") || "Artículo"}`,
      status: "draft",
      created_by: input.userId,
    })
    .select("id")
    .single()
  if (entErr || !entIns?.id) {
    await undoAfterMovementFailure()
    return { success: false, error: entErr?.message || "No se pudo crear el asiento." }
  }
  const entryId = String(entIns.id)

  const { error: linesErr } = await supabase.from("accounting_entry_lines").insert([
    {
      entry_id: entryId,
      account_id: mercaderiasId,
      debit_amount: amount,
      credit_amount: 0,
      description: INITIAL_STOCK_NOTE,
      line_order: 1,
    },
    {
      entry_id: entryId,
      account_id: offsetId,
      debit_amount: 0,
      credit_amount: amount,
      description: INITIAL_STOCK_NOTE,
      line_order: 2,
    },
  ])
  if (linesErr) {
    await supabase.from("accounting_entries").delete().eq("id", entryId)
    await undoAfterMovementFailure()
    return { success: false, error: linesErr.message || "No se pudieron crear las líneas del asiento." }
  }

  const { error: postErr } = await supabase
    .from("accounting_entries")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: input.userId,
    })
    .eq("id", entryId)
  if (postErr) {
    await supabase.from("accounting_entries").delete().eq("id", entryId)
    await undoAfterMovementFailure()
    return { success: false, error: postErr.message || "No se pudo registrar el asiento." }
  }

  return { success: true }
}
