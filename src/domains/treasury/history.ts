import type { SupabaseClient } from "@supabase/supabase-js"
import { loadUserDisplayNames } from "../operations/loaders.js"
import { loadPopOperationalContext } from "../operations/operationalDay.js"
import { timestampToLocalDateIso } from "../operations/timezone.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { resolveTreasuryAccountLedgerAccountId } from "./chart.js"
import { computeChildPendingBalanceAsOf } from "./pending.js"
import type {
  TreasuryPosSummaryMovementRow,
  TreasuryReconciliationEventRow,
  TreasuryReconciliationHistoryData,
} from "./schema.js"

function dayBeforeIso(isoDate: string): string {
  const dt = new Date(`${isoDate.slice(0, 10)}T12:00:00`)
  dt.setDate(dt.getDate() - 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
}

function saleLocalDate(soldAt: unknown, timeZone: string): string {
  return timestampToLocalDateIso(String(soldAt ?? ""), timeZone)
}

function purchaseKindLabel(kind: string): string {
  if (kind === "raw_material") return "Materia prima"
  if (kind === "supply") return "Insumo"
  if (kind === "mixed") return "Mixta"
  return "Mercadería"
}

function paymentKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "cash":
      return "Efectivo"
    case "card_debit":
      return "Tarjeta débito"
    case "card_credit":
      return "Tarjeta crédito"
    case "transfer":
      return "Transferencia"
    case "check":
      return "Cheque"
    case "other":
      return "Otro"
    default:
      return "—"
  }
}

function parseSaleChannel(raw: unknown): "table" | "counter" | "pos" {
  const channel = String(raw ?? "pos")
  if (channel === "table" || channel === "counter" || channel === "pos") {
    return channel
  }
  return "pos"
}

function formatSaleLabel(options: {
  saleChannel: "table" | "counter" | "pos"
  tableLabel?: string | null
  counterOrderLabel?: string | null
  customerName?: string | null
  paymentKind?: string | null
}): string {
  const channelLabel =
    options.saleChannel === "table"
      ? "Mesas"
      : options.saleChannel === "counter"
        ? "Mostrador"
        : options.paymentKind
          ? paymentKindLabel(options.paymentKind)
          : "Cobro directo"
  const parts = ["Venta", channelLabel]
  if (options.saleChannel === "table") {
    parts.push(options.tableLabel?.trim() || "Mesa")
  } else if (options.saleChannel === "counter") {
    parts.push(options.counterOrderLabel?.trim() || "Pedido")
  }
  parts.push(options.customerName?.trim() || "sin cliente")
  return parts.join(", ")
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
      if (Number.isFinite(n)) counters.set(String(row.id), `#${n}`)
    }
  }

  return { tables, counters }
}

async function computePeriodGrossForChildAccount(
  supabase: SupabaseClient,
  popId: string,
  childTreasuryAccountId: string,
  childRole: "pos" | "card_payable",
  inDateRange: (iso: string) => boolean,
  ledgerTimeZone: string,
): Promise<number> {
  if (childRole === "pos") {
    const { data: spRows, error: spErr } = await supabase
      .from("sale_payments")
      .select("amount, sales!inner ( sold_at, status )")
      .eq("pop_id", popId)
      .eq("treasury_account_id", childTreasuryAccountId)
      .eq("sales.status", "completed")
    if (spErr) {
      throw new Error(spErr.message || "No se pudieron cargar cobros del período.")
    }
    let total = 0
    for (const row of spRows || []) {
      const sale = row.sales as unknown as { sold_at?: string } | null
      const date = saleLocalDate(sale?.sold_at, ledgerTimeZone)
      if (!inDateRange(date)) continue
      total = roundMoney(total + parseMoney(row.amount))
    }
    return total
  }

  let total = 0
  for (const table of [
    "purchase_payments",
    "expense_payments",
    "pop_employee_payments",
  ] as const) {
    const { data, error } = await supabase
      .from(table)
      .select("amount, paid_at")
      .eq("pop_id", popId)
      .eq("treasury_account_id", childTreasuryAccountId)
    if (error) {
      throw new Error(error.message || "No se pudieron cargar cargos del período.")
    }
    for (const row of data || []) {
      const date = String(row.paid_at ?? "").slice(0, 10)
      if (!inDateRange(date)) continue
      total = roundMoney(total + parseMoney(row.amount))
    }
  }
  return total
}

async function loadPosCashRegisterCloseAdjustmentEvents(
  supabase: SupabaseClient,
  popId: string,
  childTreasuryAccountId: string,
  childName: string,
  inDateRange: (iso: string) => boolean,
): Promise<TreasuryReconciliationEventRow[]> {
  const ledgerId = await resolveTreasuryAccountLedgerAccountId(
    supabase,
    popId,
    childTreasuryAccountId,
  )
  if (!ledgerId) return []

  const { data: entryRows } = await supabase
    .from("accounting_entries")
    .select("id, entry_date, entry_number, status, description")
    .eq("pop_id", popId)
    .eq("source_type", "cash_register_close")
    .eq("status", "posted")
  const entryIds = (entryRows || []).map((row) => String(row.id))
  if (entryIds.length === 0) return []

  const entryById = new Map((entryRows || []).map((row) => [String(row.id), row]))
  const { data: lineRows } = await supabase
    .from("accounting_entry_lines")
    .select("id, entry_id, debit_amount, credit_amount, description")
    .eq("account_id", ledgerId)
    .in("entry_id", entryIds)

  const events: TreasuryReconciliationEventRow[] = []
  for (const line of lineRows || []) {
    const entryId = String(line.entry_id ?? "")
    const entry = entryById.get(entryId)
    if (!entry) continue
    const eventDate = String(entry.entry_date ?? "").slice(0, 10)
    if (!inDateRange(eventDate)) continue
    const debit = parseMoney(line.debit_amount)
    const credit = parseMoney(line.credit_amount)
    const net = roundMoney(debit - credit)
    if (Math.abs(net) < 0.01) continue
    const notes =
      (typeof line.description === "string" && line.description.trim()) ||
      (typeof entry.description === "string" && entry.description.trim()) ||
      "Ajuste de cierre de caja"
    events.push({
      id: String(line.id),
      kind: "cash_register_close_adjustment",
      eventDate,
      accountName: childName,
      principalAmount: net,
      adjustmentAmount: 0,
      totalAmount: net,
      notes,
      accountingEntryId: entryId,
      accountingEntryNumber:
        entry.entry_number != null && Number.isFinite(Number(entry.entry_number))
          ? Number(entry.entry_number)
          : null,
      accountingEntryStatus:
        entry.status != null ? String(entry.status) : null,
    })
  }
  return events
}

async function loadPosSummaryMovements(
  supabase: SupabaseClient,
  popId: string,
  childTreasuryAccountId: string,
  childName: string,
  inDateRange: (iso: string) => boolean,
  ledgerTimeZone: string,
): Promise<TreasuryPosSummaryMovementRow[]> {
  const movements: TreasuryPosSummaryMovementRow[] = []
  const { data: spRows, error: spErr } = await supabase
    .from("sale_payments")
    .select(
      `
      id,
      amount,
      sales!inner (
        sold_at,
        status,
        customer_name,
        sale_channel,
        table_session_id,
        counter_order_id
      )
    `,
    )
    .eq("pop_id", popId)
    .eq("treasury_account_id", childTreasuryAccountId)
    .eq("sales.status", "completed")
  if (spErr) {
    throw new Error(spErr.message || "No se pudieron cargar cobros POS.")
  }

  type SaleFields = {
    sold_at?: string
    customer_name?: string | null
    sale_channel?: string | null
    table_session_id?: string | null
    counter_order_id?: string | null
  }
  const { tables, counters } = await loadSaleContextLabels(
    supabase,
    popId,
    (spRows || []).map((row) => {
      const sale = row.sales as unknown as SaleFields | null
      return {
        table_session_id: sale?.table_session_id,
        counter_order_id: sale?.counter_order_id,
      }
    }),
  )

  for (const row of spRows || []) {
    const sale = row.sales as unknown as SaleFields | null
    const date = saleLocalDate(sale?.sold_at, ledgerTimeZone)
    if (!inDateRange(date)) continue
    const sessionId =
      sale?.table_session_id != null ? String(sale.table_session_id).trim() : ""
    const orderId =
      sale?.counter_order_id != null ? String(sale.counter_order_id).trim() : ""
    movements.push({
      id: String(row.id),
      kind: "pos_sale",
      date,
      amount: parseMoney(row.amount),
      direction: "in",
      label: formatSaleLabel({
        saleChannel: parseSaleChannel(sale?.sale_channel),
        tableLabel: sessionId ? tables.get(sessionId) : null,
        counterOrderLabel: orderId ? counters.get(orderId) : null,
        customerName: sale?.customer_name,
      }),
    })
  }

  const closeEvents = await loadPosCashRegisterCloseAdjustmentEvents(
    supabase,
    popId,
    childTreasuryAccountId,
    childName,
    inDateRange,
  )
  for (const event of closeEvents) {
    const signed = event.principalAmount
    if (Math.abs(signed) < 0.01) continue
    movements.push({
      id: event.id,
      kind: "cash_register_close",
      date: event.eventDate,
      amount: Math.abs(signed),
      direction: signed < 0 ? "out" : "in",
      label: event.notes.trim() || "Ajuste de cierre de caja",
    })
  }

  movements.sort((a, b) => {
    const dc = b.date.localeCompare(a.date)
    if (dc !== 0) return dc
    return b.id.localeCompare(a.id)
  })
  return movements
}

async function loadCardConsumptionMovements(
  supabase: SupabaseClient,
  popId: string,
  childTreasuryAccountId: string,
  inDateRange: (iso: string) => boolean,
): Promise<TreasuryPosSummaryMovementRow[]> {
  const movements: TreasuryPosSummaryMovementRow[] = []
  const { data: ppRows, error: ppErr } = await supabase
    .from("purchase_payments")
    .select(
      "id, amount, paid_at, purchases ( supplier_name, document_number, purchase_kind )",
    )
    .eq("pop_id", popId)
    .eq("treasury_account_id", childTreasuryAccountId)
  if (ppErr) {
    throw new Error(ppErr.message || "No se pudieron cargar consumos de compras.")
  }
  for (const row of ppRows || []) {
    const pur = row.purchases as unknown as {
      supplier_name?: string | null
      document_number?: string | null
      purchase_kind?: string | null
    } | null
    const date = String(row.paid_at ?? "").slice(0, 10)
    if (!inDateRange(date)) continue
    movements.push({
      id: String(row.id),
      kind: "purchase_payment",
      date,
      amount: parseMoney(row.amount),
      direction: "out",
      label: [
        "Compra",
        purchaseKindLabel(String(pur?.purchase_kind ?? "merchandise")),
        pur?.supplier_name?.trim() || "sin proveedor",
        ...(pur?.document_number?.trim() ? [pur.document_number.trim()] : []),
      ].join(", "),
    })
  }

  const { data: epRows, error: epErr } = await supabase
    .from("expense_payments")
    .select(
      "id, amount, paid_at, expenses ( description, expense_categories ( name ) )",
    )
    .eq("pop_id", popId)
    .eq("treasury_account_id", childTreasuryAccountId)
  if (epErr) {
    throw new Error(epErr.message || "No se pudieron cargar consumos de gastos.")
  }
  for (const row of epRows || []) {
    const exp = row.expenses as unknown as {
      description?: string | null
      expense_categories?:
        | { name?: string | null }
        | Array<{ name?: string | null }>
        | null
    } | null
    const catRel = exp?.expense_categories
    const cat = Array.isArray(catRel) ? catRel[0] : catRel
    const date = String(row.paid_at ?? "").slice(0, 10)
    if (!inDateRange(date)) continue
    const parts = ["Gasto"]
    if (cat?.name?.trim()) parts.push(cat.name.trim())
    parts.push(exp?.description?.trim() || "sin detalle")
    movements.push({
      id: String(row.id),
      kind: "expense_payment",
      date,
      amount: parseMoney(row.amount),
      direction: "out",
      label: parts.join(", "),
    })
  }

  movements.sort((a, b) => {
    const dc = b.date.localeCompare(a.date)
    if (dc !== 0) return dc
    return b.id.localeCompare(a.id)
  })
  return movements
}

function netPosSummaryMovements(movements: TreasuryPosSummaryMovementRow[]): number {
  let total = 0
  for (const movement of movements) {
    if (movement.direction === "in") total = roundMoney(total + movement.amount)
    else total = roundMoney(total - movement.amount)
  }
  return total
}

export async function getTreasuryReconciliationHistory(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  motherTreasuryAccountId: string,
  options: {
    childTreasuryAccountId?: string
    childRole?: "pos" | "card_payable"
    dateFrom: string | null
    dateTo: string | null
  },
): Promise<
  | { success: true; data: TreasuryReconciliationHistoryData }
  | { success: false; error: string; status: 500 }
> {
  try {
    const childId = options.childTreasuryAccountId?.trim() ?? ""
    const childRole = options.childRole
    const dateFrom = options.dateFrom ?? ""
    const dateTo = options.dateTo ?? ""
    const inDateRange = (iso: string) => {
      const d = iso.slice(0, 10)
      if (dateFrom && d < dateFrom) return false
      if (dateTo && d > dateTo) return false
      return true
    }

    const ctx = await loadPopOperationalContext(supabase, popId, popSiteId)
    const ledgerTimeZone = ctx.timeZone

    const { data: childRows } = await supabase
      .from("treasury_accounts")
      .select("id")
      .eq("pop_id", popId)
      .eq("parent_treasury_account_id", motherTreasuryAccountId)
    const childIds = (childRows || []).map((row) => String(row.id))
    const events: TreasuryReconciliationEventRow[] = []
    const fetchCards = childRole !== "pos"
    const fetchPos = childRole !== "card_payable"

    if (childIds.length > 0 && fetchCards) {
      let settleQuery = supabase
        .from("treasury_settlements")
        .select(
          "id, principal_amount, amount, adjustment_amount, settled_at, created_at, notes, accounting_entry_id, card_treasury_account_id, created_by",
        )
        .eq("pop_id", popId)
        .order("settled_at", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(120)
      settleQuery = childId
        ? settleQuery.eq("card_treasury_account_id", childId)
        : settleQuery.in("card_treasury_account_id", childIds)
      const { data: settleRows, error: settleErr } = await settleQuery
      if (settleErr) {
        return {
          success: false,
          error: settleErr.message || "No se pudo cargar liquidaciones.",
          status: 500,
        }
      }
      const cardIds = [
        ...new Set(
          (settleRows || [])
            .map((row) =>
              row.card_treasury_account_id
                ? String(row.card_treasury_account_id)
                : "",
            )
            .filter(Boolean),
        ),
      ]
      const cardNames = new Map<string, string>()
      if (cardIds.length > 0) {
        const { data: nameRows } = await supabase
          .from("treasury_accounts")
          .select("id, name")
          .eq("pop_id", popId)
          .in("id", cardIds)
        for (const row of nameRows || []) {
          cardNames.set(String(row.id), String(row.name ?? ""))
        }
      }
      for (const row of settleRows || []) {
        const date = String(row.settled_at ?? "").slice(0, 10)
        if (!inDateRange(date)) continue
        const principal = roundMoney(parseMoney(row.principal_amount ?? row.amount))
        const adjustment = roundMoney(parseMoney(row.adjustment_amount ?? 0))
        const cid =
          row.card_treasury_account_id != null
            ? String(row.card_treasury_account_id)
            : ""
        events.push({
          id: String(row.id),
          kind: "card_settlement",
          eventDate: date,
          eventOccurredAt: String(row.created_at ?? row.settled_at ?? "").trim(),
          accountName: cardNames.get(cid) ?? "Tarjeta",
          principalAmount: principal,
          adjustmentAmount: adjustment,
          totalAmount: roundMoney(principal + adjustment),
          notes: String(row.notes ?? ""),
          accountingEntryId:
            row.accounting_entry_id != null ? String(row.accounting_entry_id) : null,
          accountingEntryNumber: null,
          accountingEntryStatus: null,
          createdByName: row.created_by != null ? String(row.created_by) : null,
        })
      }
    }

    if (fetchPos) {
      let posQuery = supabase
        .from("treasury_pos_acreditations")
        .select(
          "id, principal_amount, adjustment_amount, credited_at, created_at, notes, accounting_entry_id, pos_treasury_account_id, created_by",
        )
        .eq("pop_id", popId)
        .eq("mother_treasury_account_id", motherTreasuryAccountId)
        .order("credited_at", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(120)
      if (childId) posQuery = posQuery.eq("pos_treasury_account_id", childId)
      const { data: posRows, error: posErr } = await posQuery
      if (posErr) {
        return {
          success: false,
          error: posErr.message || "No se pudo cargar acreditaciones POS.",
          status: 500,
        }
      }
      const posIds = [
        ...new Set(
          (posRows || [])
            .map((row) =>
              row.pos_treasury_account_id ? String(row.pos_treasury_account_id) : "",
            )
            .filter(Boolean),
        ),
      ]
      const posNames = new Map<string, string>()
      if (posIds.length > 0) {
        const { data: nameRows } = await supabase
          .from("treasury_accounts")
          .select("id, name")
          .eq("pop_id", popId)
          .in("id", posIds)
        for (const row of nameRows || []) {
          posNames.set(String(row.id), String(row.name ?? ""))
        }
      }
      for (const row of posRows || []) {
        const date = String(row.credited_at ?? "").slice(0, 10)
        if (!inDateRange(date)) continue
        const principal = roundMoney(parseMoney(row.principal_amount))
        const adjustment = roundMoney(parseMoney(row.adjustment_amount ?? 0))
        const pid =
          row.pos_treasury_account_id != null
            ? String(row.pos_treasury_account_id)
            : ""
        events.push({
          id: String(row.id),
          kind: "pos_acreditation",
          eventDate: date,
          eventOccurredAt: String(row.created_at ?? row.credited_at ?? "").trim(),
          accountName: posNames.get(pid) ?? "POS",
          principalAmount: principal,
          adjustmentAmount: adjustment,
          totalAmount: roundMoney(principal + adjustment),
          notes: String(row.notes ?? ""),
          accountingEntryId:
            row.accounting_entry_id != null ? String(row.accounting_entry_id) : null,
          accountingEntryNumber: null,
          accountingEntryStatus: null,
          createdByName: row.created_by != null ? String(row.created_by) : null,
        })
      }
    }

    const createdByIds = [
      ...new Set(
        events
          .map((event) => event.createdByName)
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    const userNames = await loadUserDisplayNames(supabase, createdByIds)
    for (const event of events) {
      if (!event.createdByName) continue
      event.createdByName = userNames.get(event.createdByName) ?? "Usuario"
    }

    const entryIds = [
      ...new Set(
        events
          .map((event) => event.accountingEntryId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    if (entryIds.length > 0) {
      const { data: entryRows } = await supabase
        .from("accounting_entries")
        .select("id, entry_number, status")
        .eq("pop_id", popId)
        .in("id", entryIds)
      const entryMeta = new Map<
        string,
        { entryNumber: number | null; status: string | null }
      >()
      for (const row of entryRows || []) {
        entryMeta.set(String(row.id), {
          entryNumber:
            row.entry_number != null && Number.isFinite(Number(row.entry_number))
              ? Number(row.entry_number)
              : null,
          status: row.status != null ? String(row.status) : null,
        })
      }
      for (const event of events) {
        if (!event.accountingEntryId) continue
        const meta = entryMeta.get(event.accountingEntryId)
        if (!meta) continue
        event.accountingEntryNumber = meta.entryNumber
        event.accountingEntryStatus = meta.status
      }
    }

    events.sort((a, b) => {
      const aKey = (a.eventOccurredAt ?? a.eventDate).trim()
      const bKey = (b.eventOccurredAt ?? b.eventDate).trim()
      const dc = bKey.localeCompare(aKey)
      if (dc !== 0) return dc
      return b.id.localeCompare(a.id)
    })

    const periodReconciledPrincipal = events.reduce(
      (sum, event) => sum + event.principalAmount,
      0,
    )

    let periodGrossAmount = 0
    let periodPendingBalance = 0
    let openingPendingBalance: number | null = null
    let periodToLiquidate = 0
    let summaryMovements: TreasuryPosSummaryMovementRow[] = []

    if (childId && childRole) {
      periodGrossAmount = await computePeriodGrossForChildAccount(
        supabase,
        popId,
        childId,
        childRole,
        inDateRange,
        ledgerTimeZone,
      )
      if (childRole === "pos") {
        const asOf =
          dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)
            ? dateTo
            : new Date().toISOString().slice(0, 10)
        periodPendingBalance = Math.max(
          0,
          await computeChildPendingBalanceAsOf(supabase, popId, childId, "pos", asOf),
        )
        if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
          openingPendingBalance = Math.max(
            0,
            await computeChildPendingBalanceAsOf(
              supabase,
              popId,
              childId,
              "pos",
              dayBeforeIso(dateFrom),
            ),
          )
        }
        const { data: childRow } = await supabase
          .from("treasury_accounts")
          .select("name")
          .eq("id", childId)
          .maybeSingle()
        const childName = String(childRow?.name ?? "POS")
        summaryMovements = await loadPosSummaryMovements(
          supabase,
          popId,
          childId,
          childName,
          inDateRange,
          ledgerTimeZone,
        )
        periodToLiquidate = netPosSummaryMovements(summaryMovements)
      } else {
        periodPendingBalance = roundMoney(
          Math.max(0, periodGrossAmount - periodReconciledPrincipal),
        )
        summaryMovements = await loadCardConsumptionMovements(
          supabase,
          popId,
          childId,
          inDateRange,
        )
      }
    }

    return {
      success: true,
      data: {
        events,
        periodGrossAmount,
        periodPendingBalance,
        openingPendingBalance,
        periodToLiquidate,
        summaryMovements,
      },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error desconocido"
    return { success: false, error: message, status: 500 }
  }
}
