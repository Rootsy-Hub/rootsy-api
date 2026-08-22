import type { SupabaseClient } from "@supabase/supabase-js"
import { loadUserDisplayNames } from "../operations/loaders.js"
import {
  DEFAULT_OPERATIONAL_DAY_CLOSE_TIME,
  expandCalendarBoundsForOperationalFetch,
  filterCashRegisterSessionsByOperationalPeriod,
  loadPopOperationalContext,
  usesOperationalDayFilter,
} from "../operations/operationalDay.js"
import {
  localDateExclusiveEndTimestamp,
  localDateStartTimestamp,
} from "../operations/timezone.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import {
  cashArqueoDifferenceFromSnapshot,
  parseClosingSnapshot,
  sessionEfectivoTeorico,
} from "./closing.js"
import type {
  CashRegisterPeriodRow,
  CashRegistersPeriodData,
  CashRegistersPeriodPopInfo,
  CashRegistersPeriodTotals,
} from "./schema.js"

const MONEY_EPS = 0.01

async function loadPeriodPopInfo(
  supabase: SupabaseClient,
  popId: string,
): Promise<CashRegistersPeriodPopInfo> {
  const { data } = await supabase
    .from("pops")
    .select("name, street_address, fiscal_cuit, fiscal_razon_social")
    .eq("id", popId)
    .maybeSingle()
  return {
    popName: data?.name != null ? String(data.name).trim() : "",
    popStreetAddress:
      data?.street_address != null ? String(data.street_address).trim() : null,
    popFiscalCuit:
      data?.fiscal_cuit != null ? String(data.fiscal_cuit).trim() : null,
    popFiscalRazonSocial:
      data?.fiscal_razon_social != null
        ? String(data.fiscal_razon_social).trim()
        : null,
  }
}

function buildClosedSessionPeriodOrFilter(
  from: string | null,
  to: string | null,
  timeZone: string,
): string | null {
  if (!from && !to) return null
  const start = from ? localDateStartTimestamp(timeZone, from) : null
  const endExclusive = to ? localDateExclusiveEndTimestamp(timeZone, to) : null
  const openedParts: string[] = []
  const closedParts: string[] = []
  if (start) {
    openedParts.push(`opened_at.gte.${start}`)
    closedParts.push(`closed_at.gte.${start}`)
  }
  if (endExclusive) {
    openedParts.push(`opened_at.lt.${endExclusive}`)
    closedParts.push(`closed_at.lt.${endExclusive}`)
  }
  const clauses: string[] = []
  if (openedParts.length > 0) clauses.push(`and(${openedParts.join(",")})`)
  if (closedParts.length > 0) clauses.push(`and(${closedParts.join(",")})`)
  return clauses.length > 0 ? clauses.join(",") : null
}

async function loadClosedSessionsInPeriod(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  from: string | null,
  to: string | null,
): Promise<
  | {
      success: true
      sessions: Array<{
        id: string
        cashRegisterId: string
        openedAt: string
        closedAt: string | null
        openingCash: number
        note: string | null
        closingSnapshot: ReturnType<typeof parseClosingSnapshot>
        openedBy: string | null
        closedBy: string | null
      }>
      timeZone: string
    }
  | { success: false; error: string }
> {
  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const useOperationalDay = usesOperationalDayFilter(
    operational.operationalDayCloseTime,
    from,
    to,
  )
  const fetchBounds = useOperationalDay
    ? expandCalendarBoundsForOperationalFetch(from, to)
    : { from, to }

  let sessQuery = supabase
    .from("cash_register_sessions")
    .select(
      "id, cash_register_id, opened_at, closed_at, opening_cash, note, closing_snapshot, opened_by, closed_by",
    )
    .eq("pop_id", popId)
    .eq("status", "closed")
  const periodOrFilter = buildClosedSessionPeriodOrFilter(
    fetchBounds.from,
    fetchBounds.to,
    operational.timeZone,
  )
  if (periodOrFilter) sessQuery = sessQuery.or(periodOrFilter)
  const { data, error } = await sessQuery
  if (error) {
    return { success: false, error: error.message || "No se pudieron cargar las sesiones." }
  }

  let mapped = (data || []).map((row) => ({
    id: String(row.id),
    cashRegisterId: String(row.cash_register_id),
    openedAt: String(row.opened_at ?? ""),
    closedAt: row.closed_at != null ? String(row.closed_at) : null,
    openingCash: parseMoney(row.opening_cash),
    note: row.note != null ? String(row.note) : null,
    closingSnapshot: parseClosingSnapshot(row.closing_snapshot),
    openedBy: row.opened_by != null ? String(row.opened_by) : null,
    closedBy: row.closed_by != null ? String(row.closed_by) : null,
  }))

  if (useOperationalDay) {
    mapped = filterCashRegisterSessionsByOperationalPeriod(
      mapped,
      from,
      to,
      operational.timeZone,
      operational.operationalDayCloseTime,
    )
  }

  return { success: true, sessions: mapped, timeZone: operational.timeZone }
}

async function loadSessionMoney(
  supabase: SupabaseClient,
  popId: string,
  sessionIds: string[],
): Promise<
  | {
      depWit: Map<string, { dep: number; wit: number }>
      saleTotals: Map<string, number>
    }
  | { error: string }
> {
  const depWit = new Map<string, { dep: number; wit: number }>()
  const saleTotals = new Map<string, number>()
  for (const id of sessionIds) {
    depWit.set(id, { dep: 0, wit: 0 })
  }
  if (sessionIds.length === 0) return { depWit, saleTotals }

  const [{ data: moveRows, error: moveErr }, { data: saleRows, error: saleErr }] =
    await Promise.all([
      supabase
        .from("cash_register_movements")
        .select("session_id, kind, amount")
        .eq("pop_id", popId)
        .in("session_id", sessionIds),
      supabase
        .from("sales")
        .select("cash_register_session_id, total")
        .eq("pop_id", popId)
        .in("cash_register_session_id", sessionIds)
        .eq("status", "completed"),
    ])
  if (moveErr) return { error: moveErr.message || "No se pudieron cargar movimientos." }
  if (saleErr) return { error: saleErr.message || "No se pudieron cargar ventas." }

  for (const movement of moveRows || []) {
    const bucket = depWit.get(String(movement.session_id))
    if (!bucket) continue
    const amount = parseMoney(movement.amount)
    if (String(movement.kind) === "deposit") bucket.dep += amount
    else if (String(movement.kind) === "withdrawal") bucket.wit += amount
  }
  for (const sale of saleRows || []) {
    const sessionId = String(sale.cash_register_session_id ?? "")
    if (!sessionId) continue
    saleTotals.set(
      sessionId,
      roundMoney((saleTotals.get(sessionId) ?? 0) + parseMoney(sale.total)),
    )
  }
  return { depWit, saleTotals }
}

export async function getCashRegistersPeriodTotals(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  from: string | null,
  to: string | null,
): Promise<
  | { success: true; data: CashRegistersPeriodTotals }
  | { success: false; error: string }
> {
  const { count: registerCount, error: regErr } = await supabase
    .from("cash_registers")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
  if (regErr) {
    return { success: false, error: regErr.message || "No se pudieron contar las cajas." }
  }

  const loaded = await loadClosedSessionsInPeriod(
    supabase,
    popId,
    popSiteId,
    from,
    to,
  )
  if (!loaded.success) return loaded
  const sessionIds = loaded.sessions.map((s) => s.id)
  const money = await loadSessionMoney(supabase, popId, sessionIds)
  if ("error" in money) return { success: false, error: money.error }

  let totalCobrado = 0
  let netDifference = 0
  let sessionsWithVariance = 0
  for (const session of loaded.sessions) {
    const dw = money.depWit.get(session.id) ?? { dep: 0, wit: 0 }
    totalCobrado += money.saleTotals.get(session.id) ?? 0
    const diff = cashArqueoDifferenceFromSnapshot(
      session.openingCash,
      roundMoney(dw.dep),
      roundMoney(dw.wit),
      session.closingSnapshot,
    )
    if (diff != null) {
      netDifference += diff
      if (Math.abs(diff) >= MONEY_EPS) sessionsWithVariance += 1
    }
  }

  return {
    success: true,
    data: {
      registerCount: registerCount ?? 0,
      closedCount: loaded.sessions.length,
      totalCobrado: roundMoney(totalCobrado),
      netDifference: roundMoney(netDifference),
      sessionsWithVariance,
    },
  }
}

export async function getCashRegistersPeriodReport(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  from: string | null,
  to: string | null,
): Promise<
  { success: true; data: CashRegistersPeriodData } | { success: false; error: string }
> {
  const [regsResult, popInfo] = await Promise.all([
    supabase
      .from("cash_registers")
      .select("id, name")
      .eq("pop_id", popId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    loadPeriodPopInfo(supabase, popId),
  ])
  if (regsResult.error) {
    return {
      success: false,
      error: regsResult.error.message || "No se pudieron cargar las cajas.",
    }
  }

  const registerRows = regsResult.data || []
  const registerNameById = new Map(
    registerRows.map((reg) => [String(reg.id), String(reg.name ?? "")]),
  )
  if (registerRows.length === 0) {
    return {
      success: true,
      data: { rows: [], registerCount: 0, popInfo },
    }
  }

  const loaded = await loadClosedSessionsInPeriod(
    supabase,
    popId,
    popSiteId,
    from,
    to,
  )
  if (!loaded.success) return loaded
  if (loaded.sessions.length === 0) {
    return {
      success: true,
      data: { rows: [], registerCount: registerRows.length, popInfo },
    }
  }

  const sessionIds = loaded.sessions.map((s) => s.id)
  const involvedRegisterIds = [
    ...new Set(loaded.sessions.map((s) => s.cashRegisterId)),
  ]
  const money = await loadSessionMoney(supabase, popId, sessionIds)
  if ("error" in money) return { success: false, error: money.error }

  const { data: numberingRows, error: numberingErr } = await supabase
    .from("cash_register_sessions")
    .select("id, cash_register_id, opened_at, opened_by, closed_by")
    .eq("pop_id", popId)
    .in("cash_register_id", involvedRegisterIds)
    .order("opened_at", { ascending: true })
  if (numberingErr) {
    return {
      success: false,
      error: numberingErr.message || "No se pudieron numerar los arqueos.",
    }
  }

  const userIds: string[] = []
  for (const session of loaded.sessions) {
    if (session.openedBy) userIds.push(session.openedBy)
    if (session.closedBy) userIds.push(session.closedBy)
  }
  const userNames = await loadUserDisplayNames(supabase, userIds)

  const arqueoNumberById = new Map<string, number>()
  const numberingByRegister = new Map<string, typeof numberingRows>()
  for (const row of numberingRows || []) {
    const registerId = String(row.cash_register_id)
    const bucket = numberingByRegister.get(registerId) ?? []
    bucket.push(row)
    numberingByRegister.set(registerId, bucket)
  }
  for (const [, rows] of numberingByRegister) {
    const ordered = [...(rows ?? [])].sort(
      (a, b) =>
        new Date(String(a.opened_at ?? "")).getTime() -
        new Date(String(b.opened_at ?? "")).getTime(),
    )
    ordered.forEach((row, index) => {
      arqueoNumberById.set(String(row.id), index + 1)
    })
  }

  const rows: CashRegisterPeriodRow[] = loaded.sessions.map((session) => {
    const dw = money.depWit.get(session.id) ?? { dep: 0, wit: 0 }
    const deposits = roundMoney(dw.dep)
    const withdrawals = roundMoney(dw.wit)
    return {
      id: session.id,
      status: "closed",
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      openingCash: session.openingCash,
      openingNote: session.note,
      closingSnapshot: session.closingSnapshot,
      movementDeposits: deposits,
      movementWithdrawals: withdrawals,
      totalCobrado: money.saleTotals.get(session.id) ?? 0,
      ventasPorMedio: [],
      ventasPorCuenta: [],
      ventasParaCierre: [],
      arqueoNumber: arqueoNumberById.get(session.id) ?? 0,
      openedByUserId: session.openedBy,
      openedByName: session.openedBy
        ? (userNames.get(session.openedBy) ?? "Usuario")
        : null,
      closedByUserId: session.closedBy,
      closedByName: session.closedBy
        ? (userNames.get(session.closedBy) ?? "Usuario")
        : null,
      efectivoTeorico: sessionEfectivoTeorico(
        session.openingCash,
        deposits,
        withdrawals,
      ),
      cashArqueoDifference: cashArqueoDifferenceFromSnapshot(
        session.openingCash,
        deposits,
        withdrawals,
        session.closingSnapshot,
      ),
      registerId: session.cashRegisterId,
      registerName: registerNameById.get(session.cashRegisterId) ?? "",
    }
  })

  rows.sort(
    (a, b) =>
      new Date(b.closedAt ?? b.openedAt).getTime() -
      new Date(a.closedAt ?? a.openedAt).getTime(),
  )

  return {
    success: true,
    data: {
      rows,
      registerCount: registerRows.length,
      popInfo,
    },
  }
}
