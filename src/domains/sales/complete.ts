import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  nextAccountingEntryNumber,
  postedAccountingEntryOps,
} from "../../audit/ledgerOps.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import { CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS } from "../current-accounts/accounts.js"
import { resolveOpenCashSession } from "../sale/cashSession.js"
import { resolveTreasuryAccountLedgerAccountId } from "../treasury/chart.js"
import {
  entryDateIsoInTimezone,
  timezoneForPopLedger,
} from "../inventory/timezone.js"
import { parseQty, roundMoney } from "../inventory/qty.js"
import { chartVentasCodesForChannel, PAYMENT_KIND_ACCOUNT_FALLBACK } from "./chart.js"
import {
  CHART_COSTO_VENTAS_CODES,
  CHART_CUENTAS_POR_COBRAR_CODES,
  CHART_IVA_PAGAR_CODES,
  CHART_MERCADERIAS_CODES,
} from "./chart.js"
import { assertClientCurrentAccountCredit } from "./credit.js"
import {
  priceComboFromSnapshot,
  resolveSaleLineDiscount,
  type SaleDiscountSource,
} from "./pricing.js"
import type { CreateSaleBody, CreateSaleLine } from "./schema.js"
import {
  buildLineDisplay,
  computeSnapshotTotals,
  SALE_SNAPSHOT_VERSION,
  saleComprobanteAccruesOutputVat,
  snapshotTotalsToMetadata,
} from "./snapshot.js"
import { buildSaleStockOps, collectStockDeductionNeeds } from "./stock.js"

type MutateResult =
  | {
      success: true
      saleId: string
      replayed?: boolean
      closedTableSessionId?: string
      linkedCounterOrderId?: string
    }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 }

type BuiltLine = {
  lineKind: "article" | "recipe" | "promotion"
  articleId: string | null
  recipeId: string | null
  promotionId: string | null
  name: string
  qty: number
  unitPrice: number
  ivaPct: number
  itemDiscountMode: "porcentaje" | "fijo" | null
  itemDiscountValue: number | null
  itemDiscount: number
  lineBase: number
  comment: string | null
  discountSource: SaleDiscountSource
  promotionDealId: string | null
  promotionDealName: string | null
  lineGroupId: string | null
  promotionSnapshot?: Record<string, unknown>
  promotionComponents?: Array<{
    kind: "article" | "recipe"
    articleId: string | null
    recipeId: string | null
    quantity: number
    name: string
  }>
}

const IVA_CONDITIONS = new Set([
  "responsable_inscripto",
  "monotributo",
  "monotributo_social",
  "consumidor_final",
  "exento",
  "no_categorizado",
])

function addIsoCalendarDays(isoDate: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate
  const [year, month, day] = isoDate.split("-").map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + days))
  return next.toISOString().slice(0, 10)
}

function summarizeQuantityDeals(lines: CreateSaleLine[]) {
  const byPromo = new Map<
    string,
    { promotionId: string; promotionName: string; discountAmount: number; lineGroupIds: string[] }
  >()
  for (const line of lines) {
    if (!line.promotionDealId || !(line.promotionDealDiscount ?? 0)) continue
    const existing = byPromo.get(line.promotionDealId)
    const groupId = line.lineGroupId
    if (existing) {
      existing.discountAmount += line.promotionDealDiscount ?? 0
      if (groupId && !existing.lineGroupIds.includes(groupId)) {
        existing.lineGroupIds.push(groupId)
      }
    } else {
      byPromo.set(line.promotionDealId, {
        promotionId: line.promotionDealId,
        promotionName: line.promotionDealName ?? "Promoción",
        discountAmount: line.promotionDealDiscount ?? 0,
        lineGroupIds: groupId ? [groupId] : [],
      })
    }
  }
  return [...byPromo.values()]
}

async function resolveAccountId(
  supabase: SupabaseClient,
  popId: string,
  codes: readonly string[],
): Promise<string | null> {
  if (codes.length === 0) return null
  const { data } = await supabase
    .from("accounting_chart_of_accounts")
    .select("id, code")
    .eq("pop_id", popId)
    .in("code", [...codes])
  const byCode = new Map(
    (data ?? []).map((row) => [String(row.code), String(row.id)]),
  )
  for (const code of codes) {
    const id = byCode.get(code)
    if (id) return id
  }
  return null
}

async function assertCashSessionStillOpen(
  supabase: SupabaseClient,
  popId: string,
  sessionId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const { data, error } = await supabase
    .from("cash_register_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .eq("status", "open")
    .maybeSingle()
  if (error) {
    return { success: false, error: error.message || "No se pudo validar la sesión de caja." }
  }
  if (!data?.id) {
    return {
      success: false,
      error: "La sesión de caja se cerró. Abrí un turno en Cajas antes de continuar.",
    }
  }
  return { success: true }
}

async function resolveCheckTreasuryAccountId(
  supabase: SupabaseClient,
  popId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("treasury_accounts")
    .select("id")
    .eq("pop_id", popId)
    .eq("kind", "check_receivable")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.id ? String(data.id) : null
}

async function loadExistingIds(
  supabase: SupabaseClient,
  popId: string,
  table: "articles" | "recipes" | "promotions",
  ids: string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Set()
  const { data } = await supabase
    .from(table)
    .select("id")
    .eq("pop_id", popId)
    .in("id", unique)
  return new Set((data ?? []).map((row) => String(row.id)))
}

async function sumChannelPaid(
  supabase: SupabaseClient,
  popId: string,
  channel: CreateSaleBody["channel"],
): Promise<number> {
  if (channel.type === "pos") return 0
  let query = supabase
    .from("sales")
    .select("total")
    .eq("pop_id", popId)
    .eq("status", "completed")
  if (channel.type === "table") {
    query = query.eq("table_session_id", channel.sessionId)
  } else {
    query = query.eq("counter_order_id", channel.orderId)
  }
  const { data } = await query
  return roundMoney(
    (data ?? []).reduce((sum, row) => sum + (Number(row.total ?? 0) || 0), 0),
  )
}

function estimateUnpaidFromCheckout(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object") return 0
  const checkout = (metadata as { checkout?: unknown }).checkout
  if (!checkout || typeof checkout !== "object") return 0
  const carrito = (checkout as { carrito?: unknown }).carrito
  if (!Array.isArray(carrito)) return 0
  let total = 0
  for (const item of carrito) {
    if (!item || typeof item !== "object") continue
    const row = item as {
      paidLocked?: boolean
      cantidad?: unknown
      snapshot?: { precio?: unknown }
    }
    if (row.paidLocked) continue
    const qty = Number(row.cantidad ?? 0) || 0
    const price = Number(row.snapshot?.precio ?? 0) || 0
    total += qty * price
  }
  return roundMoney(total)
}

function buildPricedLines(
  lines: CreateSaleLine[],
  existing: {
    articles: Set<string>
    recipes: Set<string>
    promotions: Set<string>
  },
): { success: true; built: BuiltLine[] } | { success: false; error: string } {
  const built: BuiltLine[] = []
  for (const raw of lines) {
    const qty = parseQty(raw.quantity)
    if (qty <= 0 || qty > 100000) {
      return { success: false, error: "Hay cantidades inválidas en el pedido." }
    }
    const dealDiscount = Math.max(0, Number(raw.promotionDealDiscount ?? 0) || 0)
    const suppressForDeal = dealDiscount > 0
    const snap = raw.snapshot
    const name = snap.name.trim()
    const unitPrice = roundMoney(Math.max(0, snap.unitPrice))
    const ivaPct = Math.max(0, Number(snap.iva ?? 0) || 0)

    if (raw.promotionId) {
      if (!existing.promotions.has(raw.promotionId)) {
        return { success: false, error: "Una de las promociones ya no existe." }
      }
      const selections = (raw.promotionSelections ?? []).map((sel) => ({
        slotId: sel.slotId,
        slotLabel: sel.slotLabel ?? "",
        kind: sel.kind,
        refId: sel.refId,
        name: sel.name?.trim() || name,
        listUnitPrice: Math.max(0, Number(sel.listUnitPrice ?? 0) || 0),
        slotQuantity: Math.max(1, Number(sel.slotQuantity ?? 1) || 1),
        iva: Math.max(0, Number(sel.iva ?? 0) || 0),
      }))
      for (const sel of selections) {
        const pool = sel.kind === "article" ? existing.articles : existing.recipes
        if (!pool.has(sel.refId)) {
          return {
            success: false,
            error: "Una opción de la promoción ya no existe.",
          }
        }
      }
      const priced = priceComboFromSnapshot({
        unitPrice,
        quantity: qty,
        selections,
        listTotal: snap.listTotal,
      })
      built.push({
        lineKind: "promotion",
        articleId: null,
        recipeId: null,
        promotionId: raw.promotionId,
        name,
        qty,
        unitPrice,
        ivaPct: priced.weightedIvaPct || ivaPct,
        itemDiscountMode: null,
        itemDiscountValue: null,
        itemDiscount: priced.promoDiscount,
        lineBase: priced.promoTotal,
        comment: raw.comment?.trim() || null,
        discountSource: "combo",
        promotionDealId: null,
        promotionDealName: null,
        lineGroupId: raw.lineGroupId ?? null,
        promotionSnapshot: {
          list_total: priced.listTotal,
          promo_total: priced.promoTotal,
          components: priced.components.map((c) => ({
            slot_id: c.slotId,
            slot_label: c.slotLabel,
            article_id: c.kind === "article" ? c.refId : null,
            recipe_id: c.kind === "recipe" ? c.refId : null,
            name_snapshot: c.name,
            list_unit_price: c.listUnitPrice,
            allocated_unit_price: c.allocatedUnitPrice,
            quantity: roundMoney(c.slotQuantity * qty),
            iva: c.iva,
            promo_discount: c.promoDiscount,
          })),
        },
        promotionComponents: priced.components.map((c) => ({
          kind: c.kind,
          articleId: c.kind === "article" ? c.refId : null,
          recipeId: c.kind === "recipe" ? c.refId : null,
          quantity: roundMoney(c.slotQuantity * qty),
          name: c.name,
        })),
      })
      continue
    }

    if (raw.recipeId) {
      if (!existing.recipes.has(raw.recipeId)) {
        return { success: false, error: "Una de las recetas ya no existe." }
      }
    } else if (raw.articleId) {
      if (!existing.articles.has(raw.articleId)) {
        return { success: false, error: "Uno de los artículos ya no existe." }
      }
    } else {
      return { success: false, error: "Hay una línea de venta inválida." }
    }

    const lineDiscount = resolveSaleLineDiscount({
      listUnitPrice: unitPrice,
      quantity: qty,
      catalogDiscountMode: raw.articleId ? snap.catalogDiscountMode : null,
      catalogDiscountValue: raw.articleId ? snap.catalogDiscountValue : null,
      manualMode: raw.itemDiscountMode,
      manualDraft: suppressForDeal ? "" : raw.itemDiscountDraft,
      suppressCatalogDiscount:
        raw.suppressCatalogDiscount === true || suppressForDeal,
    })
    let itemDiscount = lineDiscount.itemDiscountAmount
    let lineBase = lineDiscount.lineSubtotal
    let itemDiscountMode = lineDiscount.itemDiscountMode
    let itemDiscountValue = lineDiscount.itemDiscountValue
    let discountSource = lineDiscount.discountSource
    if (dealDiscount > 0) {
      itemDiscount = roundMoney(dealDiscount)
      lineBase = roundMoney(Math.max(0, lineBase - dealDiscount))
      itemDiscountMode = null
      itemDiscountValue = null
      discountSource = "quantity_deal"
    }
    if (lineBase < 0) {
      return { success: false, error: "Los importes de línea no son válidos." }
    }
    built.push({
      lineKind: raw.recipeId ? "recipe" : "article",
      articleId: raw.articleId ?? null,
      recipeId: raw.recipeId ?? null,
      promotionId: null,
      name,
      qty,
      unitPrice,
      ivaPct,
      itemDiscountMode,
      itemDiscountValue,
      itemDiscount,
      lineBase,
      comment: raw.comment?.trim() || null,
      discountSource,
      promotionDealId: discountSource === "quantity_deal" ? raw.promotionDealId ?? null : null,
      promotionDealName:
        discountSource === "quantity_deal" ? raw.promotionDealName ?? null : null,
      lineGroupId: raw.lineGroupId ?? null,
    })
  }
  return { success: true, built }
}

export async function completeSale(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  userId: string,
  input: CreateSaleBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: replay } = await supabase
    .from("sales")
    .select("id, status")
    .eq("pop_id", popId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle()
  if (replay?.id && String(replay.status) === "completed") {
    return { success: true, saleId: String(replay.id), replayed: true }
  }
  if (replay?.id) {
    return {
      success: false,
      error: "Esta venta ya se está registrando. Esperá un momento.",
      status: 409,
    }
  }

  const cash = await resolveOpenCashSession(supabase, popId, userId)
  if (!cash) {
    return {
      success: false,
      error: "Abrí un turno en Cajas antes de cobrar.",
      status: 400,
    }
  }
  const stillOpen = await assertCashSessionStillOpen(supabase, popId, cash.sessionId)
  if (!stillOpen.success) {
    return { success: false, error: stillOpen.error, status: 400 }
  }

  const channel = input.channel
  const tableSessionId = channel.type === "table" ? channel.sessionId : null
  const counterOrderId = channel.type === "counter" ? channel.orderId : null
  const saleChannel =
    channel.type === "table" ? "table" : channel.type === "counter" ? "counter" : "pos"
  const isPartial =
    (channel.type === "table" || channel.type === "counter") &&
    channel.partial === true

  const payOnClientAccount = Boolean(input.payOnClientAccount)
  let paymentKind = input.paymentKind ?? null
  let treasuryAccountId = input.treasuryAccountId ?? null
  if (!payOnClientAccount && paymentKind === "cash") {
    treasuryAccountId = cash.cashTreasuryAccountId
  }
  if (!payOnClientAccount && paymentKind === "check") {
    if (!input.checkDetails) {
      return { success: false, error: "Completá los datos del cheque.", status: 400 }
    }
    const checkTreasuryId = await resolveCheckTreasuryAccountId(supabase, popId)
    if (!checkTreasuryId) {
      return {
        success: false,
        error: "Faltan las cuentas de cheques. Recargá la página o contactá a soporte.",
        status: 400,
      }
    }
    treasuryAccountId = checkTreasuryId
  }
  if (!payOnClientAccount && (!paymentKind || !treasuryAccountId)) {
    return {
      success: false,
      error:
        "Elegí un medio de pago o registrá la venta a cuenta corriente del cliente.",
      status: 400,
    }
  }
  if (payOnClientAccount && !input.clientId) {
    return {
      success: false,
      error: "Para vender a cuenta corriente tenés que elegir un cliente.",
      status: 400,
    }
  }

  const articleIds = [
    ...input.lines.map((line) => line.articleId).filter(Boolean),
    ...input.lines.flatMap(
      (line) =>
        line.promotionSelections
          ?.filter((sel) => sel.kind === "article")
          .map((sel) => sel.refId) ?? [],
    ),
  ] as string[]
  const recipeIds = [
    ...input.lines.map((line) => line.recipeId).filter(Boolean),
    ...input.lines.flatMap(
      (line) =>
        line.promotionSelections
          ?.filter((sel) => sel.kind === "recipe")
          .map((sel) => sel.refId) ?? [],
    ),
  ] as string[]
  const promotionIds = input.lines
    .map((line) => line.promotionId)
    .filter(Boolean) as string[]

  const [articles, recipes, promotions] = await Promise.all([
    loadExistingIds(supabase, popId, "articles", articleIds),
    loadExistingIds(supabase, popId, "recipes", recipeIds),
    loadExistingIds(supabase, popId, "promotions", promotionIds),
  ])
  const priced = buildPricedLines(input.lines, { articles, recipes, promotions })
  if (!priced.success) return { success: false, error: priced.error, status: 400 }
  const built = priced.built

  const subtotalAfterItems = roundMoney(built.reduce((a, l) => a + l.lineBase, 0))
  const genPct = Math.max(0, Math.min(100, Number(input.valorDescuentoPorcentaje) || 0))
  const genFijo = Math.max(0, Number(input.valorDescuentoFijo) || 0)
  const generalDiscount =
    input.generalDiscountMode === "porcentaje"
      ? roundMoney(subtotalAfterItems * (genPct / 100))
      : roundMoney(Math.min(genFijo, subtotalAfterItems))
  const discountTotal = roundMoney(
    built.reduce((a, l) => a + l.itemDiscount, 0) + generalDiscount,
  )
  const total = roundMoney(subtotalAfterItems - generalDiscount)
  if (total <= 0) {
    return {
      success: false,
      error: "El total de la venta debe ser mayor que cero.",
      status: 400,
    }
  }

  let accountTermDays = CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS
  if (payOnClientAccount && input.clientId) {
    const gate = await assertClientCurrentAccountCredit(
      supabase,
      popId,
      input.clientId,
      total,
    )
    if (!gate.ok) return { success: false, error: gate.error, status: gate.status }
    accountTermDays = gate.termDays
  }

  const { data: pop } = await supabase
    .from("pops")
    .select("country")
    .eq("id", popId)
    .maybeSingle()
  const tz = timezoneForPopLedger(pop?.country, popSiteId)
  const soldDate = entryDateIsoInTimezone(tz)
  const soldAtIso = new Date().toISOString()
  const dueDateInput = String(input.dueDate ?? "").trim()
  const dueDate = payOnClientAccount
    ? /^\d{4}-\d{2}-\d{2}$/.test(dueDateInput)
      ? dueDateInput
      : addIsoCalendarDays(soldDate, accountTermDays)
    : soldDate

  let clientName: string | null = null
  let clientTaxId: string | null = null
  let clientIvaFromDb: string | null = null
  if (input.clientId) {
    const { data: cl, error: clErr } = await supabase
      .from("clients")
      .select("id, name, tax_id, iva_condition")
      .eq("id", input.clientId)
      .eq("pop_id", popId)
      .maybeSingle()
    if (clErr || !cl?.id) {
      return { success: false, error: "Cliente no encontrado en este punto.", status: 404 }
    }
    clientName = String(cl.name ?? "")
    clientTaxId = cl.tax_id ? String(cl.tax_id) : null
    const iva = cl.iva_condition != null ? String(cl.iva_condition) : null
    clientIvaFromDb = iva && IVA_CONDITIONS.has(iva) ? iva : null
  }
  const fc = input.fiscalCustomer
  if (fc?.name?.trim()) clientName = fc.name.trim()
  if (fc?.taxId?.trim()) clientTaxId = fc.taxId.trim()

  const scale = subtotalAfterItems > 0 ? roundMoney(total / subtotalAfterItems) : 1
  const fiscalLines = built.map((l) => {
    const lineFinal = roundMoney(l.lineBase * scale)
    let taxPart = 0
    let netPart = lineFinal
    if (l.ivaPct > 0) {
      taxPart = roundMoney((lineFinal * l.ivaPct) / (100 + l.ivaPct))
      netPart = roundMoney(lineFinal - taxPart)
    }
    return { ...l, lineFinal, taxPart, netPart }
  })
  let taxTotal = roundMoney(fiscalLines.reduce((a, l) => a + l.taxPart, 0))
  let subtotalNet = roundMoney(fiscalLines.reduce((a, l) => a + l.netPart, 0))
  const drift = roundMoney(total - roundMoney(subtotalNet + taxTotal))
  if (Math.abs(drift) >= 0.01 && fiscalLines.length > 0) {
    const last = fiscalLines[fiscalLines.length - 1]!
    last.netPart = roundMoney(last.netPart + drift)
    subtotalNet = roundMoney(fiscalLines.reduce((a, x) => a + x.netPart, 0))
    taxTotal = roundMoney(total - subtotalNet)
  }

  const invLabel = input.invoiceTypeLabel?.trim() || null
  const accrueOutputVat = saleComprobanteAccruesOutputVat(invLabel)
  const snapshotTotals = computeSnapshotTotals({
    lines: built.map((l) => ({
      qty: l.qty,
      unitPrice: l.unitPrice,
      listLineTotal:
        l.discountSource === "combo" && l.promotionSnapshot?.list_total != null
          ? roundMoney(Number(l.promotionSnapshot.list_total))
          : roundMoney(l.qty * l.unitPrice),
      itemDiscount: l.itemDiscount,
      discountSource: l.discountSource,
      promotionDealName: l.promotionDealName,
      name: l.name,
      lineGroupId: l.lineGroupId,
      lineKind: l.lineKind,
      itemDiscountMode: l.itemDiscountMode,
      itemDiscountValue: l.itemDiscountValue,
    })),
    generalDiscount,
    taxTotal,
    total,
    netSubtotalBeforeGeneral: subtotalAfterItems,
  })

  const lineItemsJson = fiscalLines.map((l, index) => {
    const generalShare =
      subtotalAfterItems > 0
        ? roundMoney(generalDiscount * (l.lineBase / subtotalAfterItems))
        : 0
    const display = buildLineDisplay(
      {
        qty: l.qty,
        unitPrice: l.unitPrice,
        itemDiscount: l.itemDiscount,
        discountSource: l.discountSource,
        promotionDealName: l.promotionDealName,
        name: l.name,
        lineGroupId: l.lineGroupId,
        lineKind: l.lineKind,
        itemDiscountMode: l.itemDiscountMode,
        itemDiscountValue: l.itemDiscountValue,
      },
      index,
    )
    return {
      article_id: l.articleId,
      recipe_id: l.recipeId,
      promotion_id: l.promotionId,
      line_kind: l.lineKind,
      quantity: l.qty,
      unit_price: l.unitPrice,
      iva: l.ivaPct,
      item_discount_mode: l.itemDiscountMode,
      item_discount_value: l.itemDiscountValue,
      item_discount_amount: l.itemDiscount,
      line_subtotal: l.lineBase,
      list_line_total:
        l.discountSource === "combo" && l.promotionSnapshot?.list_total != null
          ? roundMoney(Number(l.promotionSnapshot.list_total))
          : roundMoney(l.qty * l.unitPrice),
      tax_base: l.netPart,
      tax_amount: l.taxPart,
      general_discount_share: generalShare,
      line_discount: roundMoney(l.itemDiscount + generalShare),
      line_total: l.lineFinal,
      name_snapshot: l.name,
      comment: l.comment,
      discount_source: l.discountSource,
      promotion_deal_id: l.promotionDealId,
      promotion_deal_name: l.promotionDealName,
      line_group_id: l.lineGroupId,
      display: {
        group_id: display.groupId,
        group_label: display.groupLabel,
        group_type: display.groupType,
        sort_order: display.sortOrder,
      },
      ...(l.promotionSnapshot ? { promotion_snapshot: l.promotionSnapshot } : {}),
    }
  })

  const metadata: Record<string, unknown> = {
    snapshot_version: SALE_SNAPSHOT_VERSION,
    totals: snapshotTotalsToMetadata(snapshotTotals),
    invoice_accrues_output_vat: accrueOutputVat,
  }
  if (invLabel) {
    metadata.invoice_type_label = invLabel
    if (invLabel === "Recibo X") metadata.invoice_internal_only = true
  }
  if (!accrueOutputVat && taxTotal > 0) metadata.vat_included_estimate = taxTotal
  if (payOnClientAccount) metadata.pay_on_client_account = true
  const itemDiscountTotal = roundMoney(built.reduce((a, l) => a + l.itemDiscount, 0))
  if (itemDiscountTotal > 0) metadata.item_discount_total = itemDiscountTotal
  if (generalDiscount > 0) {
    metadata.general_discount_amount = generalDiscount
    metadata.general_discount_mode = input.generalDiscountMode
    metadata.general_discount_value =
      input.generalDiscountMode === "porcentaje" ? genPct : genFijo
    metadata.subtotal_before_general_discount = subtotalAfterItems
  }
  const customerIva =
    (input.customerIvaCondition && IVA_CONDITIONS.has(input.customerIvaCondition)
      ? input.customerIvaCondition
      : null) ?? clientIvaFromDb
  if (customerIva) metadata.customer_iva_condition = customerIva
  if (isPartial) metadata.partial_channel_payment = true
  const quantityDealSummaries = summarizeQuantityDeals(input.lines)
  if (quantityDealSummaries.length > 0) {
    metadata.quantity_deal_applications = quantityDealSummaries.map((d) => ({
      promotion_id: d.promotionId,
      promotion_name: d.promotionName,
      discount_amount: roundMoney(d.discountAmount),
      line_group_ids: d.lineGroupIds,
    }))
  }

  const stockNeeds = await collectStockDeductionNeeds(supabase, popId, built)
  if (!stockNeeds.success) {
    return { success: false, error: stockNeeds.error, status: stockNeeds.status }
  }

  const saleId = randomUUID()
  const stockOps = await buildSaleStockOps(
    supabase,
    popId,
    userId,
    saleId,
    stockNeeds.needs,
  )
  if (!stockOps.success) {
    return { success: false, error: stockOps.error, status: stockOps.status }
  }

  let paymentAccountId: string | null = null
  if (payOnClientAccount) {
    paymentAccountId = await resolveAccountId(
      supabase,
      popId,
      CHART_CUENTAS_POR_COBRAR_CODES,
    )
    if (!paymentAccountId) {
      return {
        success: false,
        error: "No hay cuenta Cuentas por Cobrar (p. ej. 1.1.2.01) en el plan de cuentas.",
        status: 400,
      }
    }
  } else if (paymentKind && treasuryAccountId) {
    paymentAccountId =
      (await resolveTreasuryAccountLedgerAccountId(
        supabase,
        popId,
        treasuryAccountId,
      )) ??
      (await resolveAccountId(
        supabase,
        popId,
        PAYMENT_KIND_ACCOUNT_FALLBACK[paymentKind],
      ))
    if (!paymentAccountId) {
      return {
        success: false,
        error:
          "Configurá una cuenta contable en tesorería o el plan de cuentas (caja/bancos) para registrar el cobro.",
        status: 400,
      }
    }
  }

  const ventasId = await resolveAccountId(
    supabase,
    popId,
    chartVentasCodesForChannel(saleChannel),
  )
  if (!ventasId) {
    return {
      success: false,
      error: "No hay cuenta de ingresos por ventas para este canal en el plan de cuentas.",
      status: 400,
    }
  }
  const ledgerTaxTotal = accrueOutputVat ? taxTotal : 0
  const revenueCredit = accrueOutputVat ? subtotalNet : total
  const ivaId =
    ledgerTaxTotal > 0
      ? await resolveAccountId(supabase, popId, CHART_IVA_PAGAR_CODES)
      : null
  if (ledgerTaxTotal > 0 && !ivaId) {
    return {
      success: false,
      error: "No hay cuenta de IVA a pagar (p. ej. 2.1.2.01) en el plan de cuentas.",
      status: 400,
    }
  }
  const mercaderiasId = await resolveAccountId(supabase, popId, CHART_MERCADERIAS_CODES)
  const costoVentasId = await resolveAccountId(supabase, popId, CHART_COSTO_VENTAS_CODES)
  if (stockOps.cogsTotal > 0 && (!mercaderiasId || !costoVentasId)) {
    return {
      success: false,
      error:
        "No hay cuenta de mercaderías o costo de ventas (p. ej. 1.1.3.01 / 5.1.1.01) en el plan de cuentas.",
      status: 400,
    }
  }

  const persistedSubtotal = accrueOutputVat ? subtotalNet : total
  const persistedTaxTotal = accrueOutputVat ? taxTotal : 0
  const lineItemsToPersist = accrueOutputVat
    ? lineItemsJson
    : lineItemsJson.map((li) => ({ ...li, iva: 0 }))

  const previousPaid = await sumChannelPaid(supabase, popId, channel)
  const paidAfter = roundMoney(previousPaid + total)
  let shouldCloseTable = false
  let shouldLinkCounter = false
  if (channel.type === "table") {
    shouldCloseTable = channel.closeOnComplete === true
    if (isPartial && !shouldCloseTable) {
      const { data: session } = await supabase
        .from("table_sessions")
        .select("metadata")
        .eq("id", channel.sessionId)
        .eq("pop_id", popId)
        .maybeSingle()
      const unpaid = estimateUnpaidFromCheckout(session?.metadata)
      shouldCloseTable = unpaid > 0 && paidAfter + 0.009 >= roundMoney(previousPaid + unpaid)
    }
  }
  if (channel.type === "counter") {
    shouldLinkCounter = channel.linkOnComplete === true
    if (isPartial && !shouldLinkCounter) {
      const { data: order } = await supabase
        .from("counter_orders")
        .select("metadata")
        .eq("id", channel.orderId)
        .eq("pop_id", popId)
        .maybeSingle()
      const unpaid = estimateUnpaidFromCheckout(order?.metadata)
      shouldLinkCounter =
        unpaid > 0 && paidAfter + 0.009 >= roundMoney(previousPaid + unpaid)
    }
  }
  if (tableSessionId || counterOrderId) {
    metadata.channel_paid_accumulated = paidAfter
  }

  const ops: AuditOp[] = [
    {
      op: "insert",
      table: "sales",
      row: {
        id: saleId,
        pop_id: popId,
        client_id: input.clientId ?? null,
        customer_name: clientName,
        customer_tax_id: clientTaxId,
        line_items: lineItemsToPersist,
        subtotal: persistedSubtotal,
        tax_total: persistedTaxTotal,
        discount_total: discountTotal,
        total,
        currency: "ARS",
        status: "completed",
        sold_at: soldAtIso,
        due_date: dueDate,
        cash_register_id: cash.cashRegisterId,
        cash_register_session_id: cash.sessionId,
        created_by: userId,
        metadata,
        sale_channel: saleChannel,
        table_session_id: tableSessionId,
        counter_order_id: counterOrderId,
        on_account: payOnClientAccount,
        idempotency_key: input.idempotencyKey,
      },
    },
  ]

  if (!payOnClientAccount && paymentKind && treasuryAccountId) {
    let checkId: string | null = null
    if (paymentKind === "check" && input.checkDetails) {
      checkId = randomUUID()
      ops.push({
        op: "insert",
        table: "checks",
        row: {
          id: checkId,
          pop_id: popId,
          direction: "received",
          check_number: input.checkDetails.checkNumber,
          bank_name: input.checkDetails.bankName,
          amount: total,
          issue_date: input.checkDetails.issueDate,
          due_date: input.checkDetails.dueDate,
          status: "in_portfolio",
          source_kind: "sale",
          source_id: saleId,
          client_id: input.clientId ?? (input.checkDetails.partyId || null),
          drawer_name: input.checkDetails.partyName || null,
          notes: input.checkDetails.notes || null,
          created_by: userId,
        },
      })
    }
    ops.push({
      op: "insert",
      table: "sale_payments",
      row: {
        id: randomUUID(),
        pop_id: popId,
        sale_id: saleId,
        payment_kind: paymentKind,
        treasury_account_id: treasuryAccountId,
        amount: total,
        sort_order: 0,
        check_id: checkId,
      },
    })
  }

  ops.push(...stockOps.ops)

  const entryDescription = "Venta registrada"
  const nextNum = await nextAccountingEntryNumber(supabase, popId)
  const ledgerLines = [
    {
      account_id: paymentAccountId!,
      debit_amount: total,
      credit_amount: 0,
      description: entryDescription,
      line_order: 1,
    },
    {
      account_id: ventasId,
      debit_amount: 0,
      credit_amount: revenueCredit,
      description: entryDescription,
      line_order: 2,
    },
  ]
  let order = 3
  if (ledgerTaxTotal > 0 && ivaId) {
    ledgerLines.push({
      account_id: ivaId,
      debit_amount: 0,
      credit_amount: ledgerTaxTotal,
      description: entryDescription,
      line_order: order,
    })
    order += 1
  }
  if (stockOps.cogsTotal > 0 && mercaderiasId && costoVentasId) {
    ledgerLines.push(
      {
        account_id: costoVentasId,
        debit_amount: stockOps.cogsTotal,
        credit_amount: 0,
        description: "Costo de mercaderías vendidas",
        line_order: order,
      },
      {
        account_id: mercaderiasId,
        debit_amount: 0,
        credit_amount: stockOps.cogsTotal,
        description: "Costo de mercaderías vendidas",
        line_order: order + 1,
      },
    )
  }
  ops.push(
    ...postedAccountingEntryOps({
      popId,
      userId,
      entryNumber: nextNum,
      entryDate: soldDate,
      sourceType: "sale",
      sourceId: saleId,
      description: entryDescription,
      lines: ledgerLines,
    }).ops,
  )

  if (tableSessionId && shouldCloseTable) {
    ops.push({
      op: "update",
      table: "table_sessions",
      id: tableSessionId,
      row: {
        status: "closed",
        closed_at: new Date().toISOString(),
        closed_by: userId,
      },
    })
  }
  if (counterOrderId && shouldLinkCounter) {
    ops.push({
      op: "update",
      table: "counter_orders",
      id: counterOrderId,
      row: { sale_id: saleId },
    })
  }

  const applied = await applyWithAudit(supabase, {
    kind: "sales.complete",
    ctx: audit,
    popId,
    resourceId: saleId,
    previous: null,
    next: { id: saleId, total, channel: saleChannel },
    ops,
  })
  if (!applied.success) {
    const replayed = await supabase
      .from("sales")
      .select("id")
      .eq("pop_id", popId)
      .eq("idempotency_key", input.idempotencyKey)
      .eq("status", "completed")
      .maybeSingle()
    if (replayed.data?.id) {
      return { success: true, saleId: String(replayed.data.id), replayed: true }
    }
    return { success: false, error: applied.error, status: applied.status }
  }
  return {
    success: true,
    saleId,
    closedTableSessionId:
      tableSessionId && shouldCloseTable ? tableSessionId : undefined,
    linkedCounterOrderId:
      counterOrderId && shouldLinkCounter ? counterOrderId : undefined,
  }
}
