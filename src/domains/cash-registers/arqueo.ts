import type { SupabaseClient } from "@supabase/supabase-js"
import { loadUserDisplayNames } from "../operations/loaders.js"
import { loadPopOperationalContext } from "../operations/operationalDay.js"
import { operationPaymentKindLabel } from "../operations/paymentLabels.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { hasAnyPermission } from "../../sidecar/permissions.js"
import {
  cobrosByTreasuryLineFromPayments,
  cobrosForCloseFromPayments,
} from "./cobros.js"
import { parseClosingSnapshot } from "./closing.js"
import type {
  CashRegisterOperationSaleLine,
  CashRegisterSessionArqueoDetail,
  CashRegisterSessionOperationRow,
  CashRegisterSummarySession,
} from "./schema.js"
import { closingComparisonNetDifference } from "./settlement.js"
import { buildClosingComparisonForSession } from "./summary.js"

function computeSessionEfectivoTeorico(session: {
  openingCash: number
  movementDeposits: number
  movementWithdrawals: number
  ventasPorMedio: { paymentKind: string; total: number }[]
}): number {
  const ventasEfectivo =
    session.ventasPorMedio.find((row) => row.paymentKind === "cash")?.total ?? 0
  return roundMoney(
    session.openingCash +
      ventasEfectivo +
      session.movementDeposits -
      session.movementWithdrawals,
  )
}

function parseSaleChannel(raw: unknown): "pos" | "table" | "counter" {
  const channel = String(raw ?? "pos")
  if (channel === "table" || channel === "counter" || channel === "pos") {
    return channel
  }
  return "pos"
}

function formatSaleOperationLabel(options: {
  saleChannel: "pos" | "table" | "counter"
  tableLabel?: string | null
  counterOrderLabel?: string | null
}): string {
  if (options.saleChannel === "table") {
    const raw = options.tableLabel?.trim()
    if (!raw) return "Mesa"
    return /^mesa\b/i.test(raw) ? raw : `Mesa ${raw}`
  }
  if (options.saleChannel === "counter") {
    const raw = options.counterOrderLabel?.trim()?.replace(/^#/, "")
    if (!raw) return "Mostrador"
    return /^mostrador\b/i.test(raw) ? raw : `Mostrador ${raw}`
  }
  return "Venta"
}

function parseQty(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.round(n * 1000) / 1000
}

function formatDiscountLabel(
  mode: unknown,
  value: unknown,
  amount: number,
): string | null {
  if (!(amount > 0)) return null
  if (mode === "porcentaje") {
    const pct = Number(value)
    if (Number.isFinite(pct) && pct > 0) {
      const pctText = pct % 1 === 0 ? String(pct) : pct.toFixed(1)
      return `Descuento −${pctText}%`
    }
  }
  return `Descuento −${amount.toFixed(2)}`
}

function extrasFromPromotion(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null
  const components = (raw as { components?: unknown }).components
  if (!Array.isArray(components) || components.length === 0) return null
  const names = components
    .map((item) => {
      if (!item || typeof item !== "object") return ""
      return String((item as { name_snapshot?: unknown }).name_snapshot ?? "").trim()
    })
    .filter(Boolean)
  return names.length > 0 ? names.join(" · ") : null
}

function parseSaleTicket(
  lineItemsRaw: unknown,
  discountTotal: number,
): { lines: CashRegisterOperationSaleLine[]; generalDiscountAmount: number } {
  const lines: CashRegisterOperationSaleLine[] = []
  const rawLines = Array.isArray(lineItemsRaw) ? lineItemsRaw : []
  for (const row of rawLines) {
    if (!row || typeof row !== "object") continue
    const o = row as Record<string, unknown>
    const discountAmount = parseMoney(o.item_discount_amount)
    lines.push({
      name: String(o.name_snapshot ?? "—").trim() || "—",
      quantity: parseQty(o.quantity),
      unitPrice: parseMoney(o.unit_price),
      lineTotal: parseMoney(o.line_total),
      discountAmount,
      discountLabel: formatDiscountLabel(
        o.item_discount_mode,
        o.item_discount_value,
        discountAmount,
      ),
      comment:
        typeof o.comment === "string" && o.comment.trim() ? o.comment.trim() : null,
      extras: extrasFromPromotion(o.promotion_snapshot),
    })
  }
  return {
    lines,
    generalDiscountAmount:
      Number.isFinite(discountTotal) && discountTotal > 0
        ? roundMoney(discountTotal)
        : 0,
  }
}

function formatSaleDetail(
  lineItemsRaw: unknown,
  discountTotal: number,
): string {
  const ticket = parseSaleTicket(lineItemsRaw, discountTotal)
  const parts = ticket.lines.slice(0, 6).map((line) => {
    let chunk = `${line.quantity}× ${line.name}`
    if (line.discountLabel) chunk += ` (${line.discountLabel})`
    if (line.comment) chunk += ` — ${line.comment}`
    return chunk
  })
  if (ticket.lines.length > 6) parts.push(`+${ticket.lines.length - 6} ítems más`)
  if (ticket.generalDiscountAmount > 0) parts.push("Descuento general")
  return parts.length > 0 ? parts.join(" · ") : "—"
}

function paymentLabelFromRow(payment: {
  payment_kind?: unknown
  treasury_accounts?: { name?: string } | Array<{ name?: string }> | null
}): string {
  const kind = payment.payment_kind != null ? String(payment.payment_kind).trim() : ""
  const taRaw = payment.treasury_accounts
  const taName = Array.isArray(taRaw) ? taRaw[0]?.name?.trim() : taRaw?.name?.trim()
  const kindLabel = kind ? operationPaymentKindLabel(kind) : ""
  if (kindLabel && taName) return `${kindLabel} — ${taName}`
  return kindLabel || taName || "—"
}

async function loadSaleContextLabels(
  supabase: SupabaseClient,
  popId: string,
  saleRows: Array<{
    table_session_id?: string | null
    counter_order_id?: string | null
  }>,
): Promise<{ tables: Map<string, string>; counters: Map<string, string> }> {
  const sessionIds = [
    ...new Set(
      saleRows
        .map((row) =>
          row.table_session_id != null ? String(row.table_session_id).trim() : "",
        )
        .filter(Boolean),
    ),
  ]
  const orderIds = [
    ...new Set(
      saleRows
        .map((row) =>
          row.counter_order_id != null ? String(row.counter_order_id).trim() : "",
        )
        .filter(Boolean),
    ),
  ]
  const tables = new Map<string, string>()
  const counters = new Map<string, string>()

  if (sessionIds.length > 0) {
    const { data: sessions } = await supabase
      .from("table_sessions")
      .select("id, dining_table_id, table_session_tables ( dining_table_id )")
      .eq("pop_id", popId)
      .in("id", sessionIds)
    const tableIds = new Set<string>()
    for (const session of sessions || []) {
      if (session.dining_table_id) tableIds.add(String(session.dining_table_id))
      const extras = session.table_session_tables as
        | Array<{ dining_table_id?: string }>
        | null
      for (const extra of extras ?? []) {
        if (extra.dining_table_id) tableIds.add(String(extra.dining_table_id))
      }
    }
    if (tableIds.size > 0) {
      const { data: dining } = await supabase
        .from("dining_tables")
        .select("id, label")
        .eq("pop_id", popId)
        .in("id", [...tableIds])
      const labelById = new Map<string, string>()
      for (const table of dining || []) {
        const label = typeof table.label === "string" ? table.label.trim() : ""
        if (label) labelById.set(String(table.id), label)
      }
      for (const session of sessions || []) {
        const ordered = [String(session.dining_table_id)]
        const extras = session.table_session_tables as
          | Array<{ dining_table_id?: string }>
          | null
        for (const extra of extras ?? []) {
          const id = extra.dining_table_id ? String(extra.dining_table_id) : ""
          if (id && !ordered.includes(id)) ordered.push(id)
        }
        const labels = ordered
          .map((id) => labelById.get(id))
          .filter((label): label is string => Boolean(label))
        if (labels.length > 0) tables.set(String(session.id), labels.join(" + "))
      }
    }
  }

  if (orderIds.length > 0) {
    const { data } = await supabase
      .from("counter_orders")
      .select("id, order_number")
      .eq("pop_id", popId)
      .in("id", orderIds)
    for (const row of data || []) {
      const n = Number(row.order_number)
      if (Number.isFinite(n)) counters.set(String(row.id), String(n))
    }
  }

  return { tables, counters }
}

export async function getCashRegisterSessionArqueo(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  sessionId: string,
  keys: readonly string[],
  isOwner: boolean,
): Promise<
  | { success: true; data: CashRegisterSessionArqueoDetail }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: sessRow, error: sessErr } = await supabase
    .from("cash_register_sessions")
    .select(
      "id, pop_id, cash_register_id, status, opened_at, closed_at, opening_cash, note, closing_snapshot, opened_by, closed_by",
    )
    .eq("id", sessionId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (sessErr || !sessRow?.id) {
    return {
      success: false,
      error: sessErr?.message || "Turno no encontrado.",
      status: 404,
    }
  }

  const registerId = String(sessRow.cash_register_id)
  const [{ data: regRow }, operational, { data: allSessRows }] = await Promise.all([
    supabase
      .from("cash_registers")
      .select("name")
      .eq("id", registerId)
      .eq("pop_id", popId)
      .maybeSingle(),
    loadPopOperationalContext(supabase, popId, popSiteId),
    supabase
      .from("cash_register_sessions")
      .select("id, opened_at")
      .eq("pop_id", popId)
      .eq("cash_register_id", registerId)
      .order("opened_at", { ascending: true }),
  ])

  const { data: moveRows, error: moveErr } = await supabase
    .from("cash_register_movements")
    .select("id, kind, amount, note, created_at, created_by")
    .eq("pop_id", popId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
  if (moveErr) {
    return {
      success: false,
      error: moveErr.message || "No se pudieron cargar los movimientos.",
      status: 500,
    }
  }

  let dep = 0
  let wit = 0
  for (const movement of moveRows || []) {
    const amt = parseMoney(movement.amount)
    if (String(movement.kind) === "deposit") dep += amt
    else if (String(movement.kind) === "withdrawal") wit += amt
  }

  const ordered = [...(allSessRows || [])]
  const arqueoNumber =
    ordered.findIndex((row) => String(row.id) === sessionId) + 1

  const openedByUserId = sessRow.opened_by != null ? String(sessRow.opened_by) : null
  const closedByUserId = sessRow.closed_by != null ? String(sessRow.closed_by) : null
  const userNames = await loadUserDisplayNames(supabase, [
    openedByUserId ?? "",
    closedByUserId ?? "",
  ])

  const st = String(sessRow.status) === "closed" ? "closed" : "open"
  const session: CashRegisterSummarySession = {
    id: sessionId,
    status: st,
    openedAt: String(sessRow.opened_at ?? ""),
    closedAt: sessRow.closed_at != null ? String(sessRow.closed_at) : null,
    openingCash: parseMoney(sessRow.opening_cash),
    openingNote: sessRow.note != null ? String(sessRow.note) : null,
    closingSnapshot:
      st === "closed" ? parseClosingSnapshot(sessRow.closing_snapshot) : null,
    movementDeposits: roundMoney(dep),
    movementWithdrawals: roundMoney(wit),
    totalCobrado: 0,
    ventasPorMedio: [],
    ventasPorCuenta: [],
    ventasParaCierre: [],
    arqueoNumber: arqueoNumber > 0 ? arqueoNumber : 0,
    openedByUserId,
    openedByName: openedByUserId
      ? (userNames.get(openedByUserId) ?? "Usuario")
      : null,
    closedByUserId,
    closedByName: closedByUserId
      ? (userNames.get(closedByUserId) ?? "Usuario")
      : null,
    efectivoTeorico: 0,
    cashArqueoDifference: null,
  }

  const operations: CashRegisterSessionOperationRow[] = []
  const canReadSales = hasAnyPermission(keys, ["sale:read"], isOwner)

  if (canReadSales) {
    const { data: saleRows, error: saleErr } = await supabase
      .from("sales")
      .select(
        `
        id,
        sold_at,
        status,
        total,
        discount_total,
        customer_name,
        client_id,
        sale_channel,
        table_session_id,
        counter_order_id,
        line_items,
        sale_payments (
          amount,
          sort_order,
          payment_kind,
          treasury_account_id,
          reversed_at,
          treasury_accounts ( name, parent_treasury_account_id )
        )
      `,
      )
      .eq("pop_id", popId)
      .eq("cash_register_session_id", sessionId)
      .eq("status", "completed")
      .order("sold_at", { ascending: false })
    if (saleErr) {
      return {
        success: false,
        error: saleErr.message || "No se pudieron cargar las ventas.",
        status: 500,
      }
    }

    const { tables, counters } = await loadSaleContextLabels(
      supabase,
      popId,
      saleRows || [],
    )

    const paymentSums = new Map<string, number>()
    let totalCobrado = 0
    const flatPayments: Array<{
      sale_id?: unknown
      payment_kind?: unknown
      amount?: unknown
      treasury_account_id?: unknown
      reversed_at?: unknown
      treasury_accounts?:
        | { name?: string; parent_treasury_account_id?: string | null }
        | Array<{ name?: string; parent_treasury_account_id?: string | null }>
        | null
    }> = []

    for (const row of saleRows || []) {
      const saleId = String(row.id)
      const saleChannel = parseSaleChannel(row.sale_channel)
      const tableSessionId =
        row.table_session_id != null ? String(row.table_session_id).trim() : ""
      const orderId =
        row.counter_order_id != null ? String(row.counter_order_id).trim() : ""
      const operationLabel = formatSaleOperationLabel({
        saleChannel,
        tableLabel: tableSessionId ? tables.get(tableSessionId) : null,
        counterOrderLabel: orderId ? counters.get(orderId) : null,
      })
      const customerLabel =
        row.customer_name != null && String(row.customer_name).trim()
          ? String(row.customer_name).trim()
          : row.client_id
            ? "Cliente registrado"
            : "Consumidor final"
      const ticket = parseSaleTicket(row.line_items, parseMoney(row.discount_total))
      const detail = formatSaleDetail(row.line_items, parseMoney(row.discount_total))
      const paymentsRaw = row.sale_payments as
        | Array<{
            amount?: unknown
            sort_order?: unknown
            payment_kind?: unknown
            treasury_account_id?: unknown
            reversed_at?: unknown
            treasury_accounts?:
              | { name?: string; parent_treasury_account_id?: string | null }
              | Array<{ name?: string; parent_treasury_account_id?: string | null }>
              | null
          }>
        | null
      const payList = Array.isArray(paymentsRaw) ? [...paymentsRaw] : []
      payList.sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      totalCobrado += parseMoney(row.total)

      if (payList.length === 0) {
        operations.push({
          id: saleId,
          kind: "sale",
          saleId,
          occurredAt: String(row.sold_at ?? ""),
          operationLabel,
          customerLabel,
          detail,
          paymentMethodLabel: "—",
          amount: parseMoney(row.total),
          lines: ticket.lines,
          showLines: true,
          generalDiscountAmount: ticket.generalDiscountAmount,
        })
      } else {
        for (const [index, payment] of payList.entries()) {
          const kind = String(payment.payment_kind ?? "other")
          const amount = parseMoney(payment.amount)
          paymentSums.set(kind, (paymentSums.get(kind) ?? 0) + amount)
          flatPayments.push({ ...payment, sale_id: saleId })
          operations.push({
            id: `${saleId}-${index}`,
            kind: "sale",
            saleId,
            occurredAt: String(row.sold_at ?? ""),
            operationLabel,
            customerLabel,
            detail,
            paymentMethodLabel: paymentLabelFromRow(payment),
            amount,
            lines: ticket.lines,
            showLines: index === 0,
            generalDiscountAmount: ticket.generalDiscountAmount,
          })
        }
      }
    }

    session.totalCobrado = roundMoney(totalCobrado)
    session.ventasPorMedio = [...paymentSums.entries()]
      .map(([paymentKind, total]) => ({
        paymentKind,
        name: operationPaymentKindLabel(paymentKind),
        total: roundMoney(total),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
    session.ventasPorCuenta = cobrosByTreasuryLineFromPayments(flatPayments)
    session.ventasParaCierre = cobrosForCloseFromPayments(flatPayments)
  }

  for (const movement of moveRows || []) {
    const kind = String(movement.kind) === "withdrawal" ? "withdrawal" : "deposit"
    operations.push({
      id: String(movement.id),
      kind,
      saleId: null,
      occurredAt: String(movement.created_at ?? ""),
      operationLabel: kind === "deposit" ? "Ingreso" : "Retiro",
      customerLabel: "—",
      detail:
        movement.note != null && String(movement.note).trim()
          ? String(movement.note).trim()
          : kind === "deposit"
            ? "Ingreso al cajón"
            : "Retiro del cajón",
      paymentMethodLabel: "Efectivo",
      amount: parseMoney(movement.amount),
      lines: [],
      showLines: false,
      generalDiscountAmount: 0,
    })
  }

  operations.sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  )

  session.efectivoTeorico = computeSessionEfectivoTeorico(session)
  session.cashArqueoDifference =
    session.status === "closed" && session.closingSnapshot
      ? closingComparisonNetDifference(buildClosingComparisonForSession(session))
      : null

  const { data: entryRow } = await supabase
    .from("accounting_entries")
    .select("id")
    .eq("pop_id", popId)
    .eq("source_type", "cash_register_close")
    .eq("source_id", sessionId)
    .eq("status", "posted")
    .maybeSingle()

  return {
    success: true,
    data: {
      registerName: String(regRow?.name ?? ""),
      popName: operational.popName,
      session,
      closingComparison: session.closingSnapshot
        ? buildClosingComparisonForSession(session)
        : [],
      hasAccountingEntry: Boolean(entryRow?.id),
      operations,
    },
  }
}
