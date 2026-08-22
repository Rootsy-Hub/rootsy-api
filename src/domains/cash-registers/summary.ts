import type { SupabaseClient } from "@supabase/supabase-js"
import { loadUserDisplayNames } from "../operations/loaders.js"
import { loadPopOperationalContext } from "../operations/operationalDay.js"
import { operationPaymentKindLabel } from "../operations/paymentLabels.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { parseClosingSnapshot } from "./closing.js"
import {
  cobrosByTreasuryLineFromPayments,
  cobrosForCloseFromPayments,
  loadCompletedSalesForSessions,
  loadSalePaymentsForSaleIds,
} from "./cobros.js"
import type {
  CashRegisterArqueoVentaPorMedio,
  CashRegisterPageData,
  CashRegisterSessionMoney,
  CashRegisterSummaryClosingBlock,
  CashRegisterSummaryMovement,
  CashRegisterSummarySession,
  CashRegisterTotalsData,
} from "./schema.js"
import {
  loadSessionCurrentAccountCash,
} from "./sessionCash.js"
import {
  buildClosingComparisonLines,
  buildClosingComparisonLinesByTreasury,
  closingComparisonNetDifference,
  closingSnapshotUsesAccountLines,
} from "./settlement.js"

function paymentMethodLabel(id: string): string {
  if (id === "__cash_counted") return "Efectivo (contado al cierre)"
  return operationPaymentKindLabel(id)
}

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

function buildClosingComparisonForSession(session: CashRegisterSummarySession) {
  const cs = session.closingSnapshot
  if (!cs) return []
  if (cs.treasury_lines && Object.keys(cs.treasury_lines).length > 0) {
    const cobradoRows = closingSnapshotUsesAccountLines(cs)
      ? session.ventasParaCierre
      : session.ventasPorCuenta
    return buildClosingComparisonLinesByTreasury({
      efectivoTeorico: session.efectivoTeorico,
      cashCounted: cs.cash,
      treasuryLines: cs.treasury_lines,
      cobradoPorLinea: cobradoRows.map((row) => ({
        key: row.key,
        paymentKind: row.paymentKind,
        treasuryAccountId: row.treasuryAccountId,
        accountName: row.accountName,
        label: row.label,
        total: row.total,
      })),
    })
  }
  return buildClosingComparisonLines({
    efectivoTeorico: session.efectivoTeorico,
    cashCounted: cs.cash,
    paymentMethods: cs.payment_methods ?? {},
    cobradoPorMedio: session.ventasPorMedio.map((row) => ({
      paymentKind: row.paymentKind,
      total: row.total,
    })),
  })
}

function buildClosingBlocksFromSessions(
  sessions: CashRegisterSummarySession[],
): {
  closingBlocks: CashRegisterSummaryClosingBlock[]
  aggregatedClosingLines: { label: string; amount: number }[]
} {
  const closingBlocks: CashRegisterSummaryClosingBlock[] = []
  const agg = new Map<string, number>()
  for (const sess of sessions) {
    if (sess.status !== "closed" || !sess.closingSnapshot) continue
    const lines = buildClosingComparisonForSession(sess).map((line) => ({
      label: line.label,
      amount: line.informado,
    }))
    for (const line of lines) {
      const key =
        line.label === paymentMethodLabel("__cash_counted")
          ? "__agg_cash"
          : line.label
      agg.set(key, (agg.get(key) ?? 0) + line.amount)
    }
    closingBlocks.push({
      sessionId: sess.id,
      openedAt: sess.openedAt,
      closedAt: sess.closedAt,
      lines,
    })
  }
  const aggregatedClosingLines: { label: string; amount: number }[] = []
  if (agg.has("__agg_cash")) {
    aggregatedClosingLines.push({
      label: paymentMethodLabel("__cash_counted"),
      amount: roundMoney(agg.get("__agg_cash") ?? 0),
    })
  }
  for (const [pid, total] of agg) {
    if (pid === "__agg_cash") continue
    aggregatedClosingLines.push({ label: pid, amount: roundMoney(total) })
  }
  aggregatedClosingLines.sort((a, b) => a.label.localeCompare(b.label, "es"))
  return { closingBlocks, aggregatedClosingLines }
}

export async function getCashRegisterPage(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  registerId: string,
): Promise<
  | { success: true; data: CashRegisterPageData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const { data: reg, error: regErr } = await supabase
    .from("cash_registers")
    .select("id, name, is_active")
    .eq("pop_id", popId)
    .eq("id", registerId)
    .maybeSingle()
  if (regErr) {
    return {
      success: false,
      error: regErr.message || "No se pudo cargar la caja.",
      status: 500,
    }
  }
  if (!reg) {
    return { success: false, error: "Caja no encontrada.", status: 404 }
  }

  const { data: sessRows, error: sessErr } = await supabase
    .from("cash_register_sessions")
    .select(
      "id, status, opened_at, closed_at, opening_cash, note, closing_snapshot, opened_by, closed_by",
    )
    .eq("pop_id", popId)
    .eq("cash_register_id", registerId)
    .order("opened_at", { ascending: false })
  if (sessErr) {
    return {
      success: false,
      error: sessErr.message || "No se pudieron cargar los turnos.",
      status: 500,
    }
  }

  const sessionIds = (sessRows || []).map((s) => String(s.id))
  let moveRows: {
    id: unknown
    session_id: unknown
    kind: unknown
    amount: unknown
    note: unknown
    created_at: unknown
    created_by: unknown
  }[] = []
  if (sessionIds.length > 0) {
    const { data: m, error: mErr } = await supabase
      .from("cash_register_movements")
      .select("id, session_id, kind, amount, note, created_at, created_by")
      .eq("pop_id", popId)
      .in("session_id", sessionIds)
      .order("created_at", { ascending: false })
    if (mErr) {
      return {
        success: false,
        error: mErr.message || "No se pudieron cargar los movimientos.",
        status: 500,
      }
    }
    moveRows = m || []
  }

  const sessionOpenedAt = new Map<string, string>()
  const depWit = new Map<string, { dep: number; wit: number }>()
  for (const s of sessRows || []) {
    const id = String(s.id)
    sessionOpenedAt.set(id, String(s.opened_at ?? ""))
    depWit.set(id, { dep: 0, wit: 0 })
  }
  for (const m of moveRows) {
    const amt = parseMoney(m.amount)
    const bucket = depWit.get(String(m.session_id))
    if (!bucket) continue
    if (String(m.kind) === "deposit") bucket.dep += amt
    else if (String(m.kind) === "withdrawal") bucket.wit += amt
  }

  const userIds: string[] = []
  for (const s of sessRows || []) {
    if (s.opened_by) userIds.push(String(s.opened_by))
    if (s.closed_by) userIds.push(String(s.closed_by))
  }
  const userNames = await loadUserDisplayNames(supabase, userIds)
  const ordered = [...(sessRows || [])].sort(
    (a, b) =>
      new Date(String(a.opened_at ?? "")).getTime() -
      new Date(String(b.opened_at ?? "")).getTime(),
  )
  const arqueoNumberById = new Map<string, number>()
  ordered.forEach((row, index) => {
    arqueoNumberById.set(String(row.id), index + 1)
  })

  const sessions: CashRegisterSummarySession[] = (sessRows || []).map((s) => {
    const id = String(s.id)
    const st = String(s.status) === "closed" ? "closed" : "open"
    const dw = depWit.get(id) ?? { dep: 0, wit: 0 }
    const openedByUserId = s.opened_by != null ? String(s.opened_by) : null
    const closedByUserId = s.closed_by != null ? String(s.closed_by) : null
    const openingCash = parseMoney(s.opening_cash)
    return {
      id,
      status: st,
      openedAt: String(s.opened_at ?? ""),
      closedAt: s.closed_at != null ? String(s.closed_at) : null,
      openingCash,
      openingNote: s.note != null ? String(s.note) : null,
      closingSnapshot:
        st === "closed" ? parseClosingSnapshot(s.closing_snapshot) : null,
      movementDeposits: roundMoney(dw.dep),
      movementWithdrawals: roundMoney(dw.wit),
      totalCobrado: 0,
      ventasPorMedio: [],
      ventasPorCuenta: [],
      ventasParaCierre: [],
      arqueoNumber: arqueoNumberById.get(id) ?? 0,
      openedByUserId,
      openedByName: openedByUserId
        ? (userNames.get(openedByUserId) ?? "Usuario")
        : null,
      closedByUserId,
      closedByName: closedByUserId
        ? (userNames.get(closedByUserId) ?? "Usuario")
        : null,
      efectivoTeorico: roundMoney(openingCash + dw.dep - dw.wit),
      cashArqueoDifference: null,
    }
  })

  const movements: CashRegisterSummaryMovement[] = moveRows.map((m) => ({
    id: String(m.id),
    sessionId: String(m.session_id),
    sessionOpenedAt: sessionOpenedAt.get(String(m.session_id)) ?? "",
    createdAt: String(m.created_at ?? ""),
    kind: String(m.kind) === "withdrawal" ? "withdrawal" : "deposit",
    amount: parseMoney(m.amount),
    note: m.note != null ? String(m.note) : null,
    createdBy: m.created_by != null ? String(m.created_by) : null,
  }))

  return {
    success: true,
    data: {
      registerId,
      registerName: String(reg.name ?? ""),
      isActive: Boolean(reg.is_active),
      operationalDayCloseTime: operational.operationalDayCloseTime,
      sessions,
      movements,
    },
  }
}

export async function getCashRegisterTotals(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  registerId: string,
): Promise<
  | { success: true; data: CashRegisterTotalsData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const page = await getCashRegisterPage(supabase, popId, popSiteId, registerId)
  if (!page.success) return page

  const sessions = page.data.sessions.map((s) => ({ ...s }))
  const sessionIds = sessions.map((s) => s.id)
  const sales = await loadCompletedSalesForSessions(supabase, popId, sessionIds)
  const payments = await loadSalePaymentsForSaleIds(
    supabase,
    popId,
    sales.map((s) => s.id),
    false,
  )

  const paymentsBySession = new Map<string, typeof payments>()
  const saleSessionById = new Map(sales.map((s) => [s.id, s.sessionId]))
  const saleTotals = new Map<string, number>()
  for (const sale of sales) {
    saleTotals.set(sale.sessionId, (saleTotals.get(sale.sessionId) ?? 0) + sale.total)
  }
  for (const pay of payments) {
    const sessionId = saleSessionById.get(String(pay.sale_id ?? ""))
    if (!sessionId) continue
    const list = paymentsBySession.get(sessionId) ?? []
    list.push(pay)
    paymentsBySession.set(sessionId, list)
  }

  const { data: allCompletedSaleIds } = await supabase
    .from("sales")
    .select("id")
    .eq("pop_id", popId)
    .eq("cash_register_id", registerId)
    .eq("status", "completed")
  const saleIdList = (allCompletedSaleIds || []).map((r) => String(r.id))
  let ventasPorMedioPago: CashRegisterArqueoVentaPorMedio[] = []
  if (saleIdList.length > 0) {
    const { data: spRows } = await supabase
      .from("sale_payments")
      .select("payment_kind, amount")
      .eq("pop_id", popId)
      .in("sale_id", saleIdList)
    const sums = new Map<string, number>()
    for (const row of spRows || []) {
      const kind = String(row.payment_kind ?? "other")
      sums.set(kind, (sums.get(kind) ?? 0) + parseMoney(row.amount))
    }
    ventasPorMedioPago = [...sums.entries()]
      .map(([paymentKind, total]) => ({
        paymentKind,
        name: operationPaymentKindLabel(paymentKind),
        kind: paymentKind,
        totalVentas: roundMoney(total),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
  }

  const sessionsById: Record<string, CashRegisterSessionMoney> = {}
  for (const session of sessions) {
    const sessionPays = paymentsBySession.get(session.id) ?? []
    const kindSums = new Map<string, number>()
    for (const row of sessionPays) {
      const kind = String(row.payment_kind ?? "other")
      kindSums.set(kind, (kindSums.get(kind) ?? 0) + parseMoney(row.amount))
    }
    session.totalCobrado = roundMoney(saleTotals.get(session.id) ?? 0)
    session.ventasPorMedio = [...kindSums.entries()]
      .map(([paymentKind, total]) => ({
        paymentKind,
        name: operationPaymentKindLabel(paymentKind),
        total: roundMoney(total),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
    session.ventasPorCuenta = cobrosByTreasuryLineFromPayments(sessionPays)
    session.ventasParaCierre = cobrosForCloseFromPayments(sessionPays)
    session.efectivoTeorico = computeSessionEfectivoTeorico(session)
    session.cashArqueoDifference =
      session.status === "closed" && session.closingSnapshot
        ? closingComparisonNetDifference(buildClosingComparisonForSession(session))
        : null
    sessionsById[session.id] = {
      totalCobrado: session.totalCobrado,
      ventasPorMedio: session.ventasPorMedio,
      ventasPorCuenta: session.ventasPorCuenta,
      ventasParaCierre: session.ventasParaCierre,
      efectivoTeorico: session.efectivoTeorico,
      cashArqueoDifference: session.cashArqueoDifference,
    }
  }

  let sesionAbierta = null
  const openSess = sessions.find((s) => s.status === "open")
  if (openSess) {
    const ventasEfectivo =
      openSess.ventasPorMedio.find((row) => row.paymentKind === "cash")?.total ??
      0
    const ccCash = await loadSessionCurrentAccountCash(supabase, popId, openSess.id)
    const ventasConCc = roundMoney(ventasEfectivo + ccCash.inbound)
    const egresosCajon = roundMoney(
      openSess.movementWithdrawals + ccCash.outbound,
    )
    sesionAbierta = {
      sessionId: openSess.id,
      openingCash: openSess.openingCash,
      ventasEfectivo: ventasConCc,
      ingresosCajon: openSess.movementDeposits,
      egresosCajon,
      efectivoTeoricoEnCajon: roundMoney(
        openSess.openingCash + ventasConCc + openSess.movementDeposits - egresosCajon,
      ),
    }
  }

  const { closingBlocks, aggregatedClosingLines } =
    buildClosingBlocksFromSessions(sessions)
  let depositTotal = 0
  let withdrawalTotal = 0
  for (const s of sessions) {
    depositTotal += s.movementDeposits
    withdrawalTotal += s.movementWithdrawals
  }

  return {
    success: true,
    data: {
      sessionsById,
      arqueo: { ventasPorMedioPago, sesionAbierta },
      totals: {
        depositTotal: roundMoney(depositTotal),
        withdrawalTotal: roundMoney(withdrawalTotal),
        netCashMovements: roundMoney(depositTotal - withdrawalTotal),
      },
      closingBlocks,
      aggregatedClosingLines,
    },
  }
}
