import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { timestampToLocalDateIso } from "../operations/timezone.js"
import { loadPopOperationalContext } from "../operations/operationalDay.js"
import {
  isCardPayableChartCode,
  isMotherTreasuryAccount,
  isSettlementReceivableChartCode,
  parseTreasuryKind,
  type TreasuryAccountKind,
} from "./kinds.js"
import type {
  BankStatementLineRow,
  PaymentKind,
  TreasuryAccountMovementsData,
  TreasuryMovementRow,
  TreasurySettlementRow,
} from "./schema.js"

const PAYMENT_KINDS: PaymentKind[] = [
  "cash",
  "card_debit",
  "card_credit",
  "transfer",
  "check",
  "other",
]

type AccountMeta = {
  name: string
  kind: TreasuryAccountKind
  chartCode: string
}

function parsePaymentKind(v: unknown): PaymentKind | null {
  const k = String(v ?? "").trim()
  return PAYMENT_KINDS.includes(k as PaymentKind) ? (k as PaymentKind) : null
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

function treasuryLabel(meta: AccountMeta | undefined): string {
  if (!meta) return "—"
  if (meta.name.trim()) return meta.name.trim()
  if (isSettlementReceivableChartCode(meta.chartCode)) return "Terminal POS"
  if (isCardPayableChartCode(meta.chartCode) || meta.kind === "card_payable") {
    return "Tarjeta corporativa"
  }
  return "Cuenta"
}

function movementRefId(kind: TreasuryMovementRow["kind"], id: string): string {
  if (kind === "funding_out" && id.startsWith("fund-")) return id.slice(5)
  return id
}

function resolveImpact(
  kind: TreasuryMovementRow["kind"],
  sourceAccountName?: string | null,
): "real" | "informative" {
  switch (kind) {
    case "pos_liquidation":
      return "real"
    case "pos_liquidation_fee":
    case "cash_register_close":
      return "informative"
    case "sale":
      return sourceAccountName ? "informative" : "real"
    default:
      return "real"
  }
}

function purchaseKindLabel(kind: string): string {
  if (kind === "raw_material") return "Materia prima"
  if (kind === "supply") return "Insumo"
  if (kind === "mixed") return "Mixta"
  return "Mercadería"
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
): Promise<{
  tables: Map<string, string>
  counters: Map<string, string>
}> {
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
      for (const table of dining ?? []) {
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

export async function getTreasuryAccountMovements(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  accountId: string,
  dateFrom: string | null,
  dateTo: string | null,
  relatedIds: string[],
): Promise<
  | { success: true; data: TreasuryAccountMovementsData }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: taRow, error: taErr } = await supabase
    .from("treasury_accounts")
    .select(
      `
      id,
      kind,
      name,
      accounting_chart_of_accounts ( code )
    `,
    )
    .eq("id", accountId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (taErr) {
    return { success: false, error: taErr.message || "Error", status: 500 }
  }
  if (!taRow?.id) {
    return { success: false, error: "Cuenta no encontrada.", status: 404 }
  }

  const accountKind = parseTreasuryKind(taRow.kind)
  const isCardPayable = accountKind === "card_payable"
  const isCashAccount = accountKind === "cash"
  const isHeavy = isCashAccount || accountKind === "bank" || accountKind === "wallet"
  const primaryName = String(taRow.name ?? "")
  const primaryChart = taRow.accounting_chart_of_accounts as unknown as {
    code?: string
  } | null
  const primaryChartCode = String(primaryChart?.code ?? "")
  const related = relatedIds.filter((id) => id && id !== accountId)
  const isMother = isMotherTreasuryAccount(primaryChartCode)
  const movementFetchLimit = isHeavy ? 500 : related.length > 0 ? 200 : 80
  const paymentOutFetchLimit = isHeavy ? 200 : related.length > 0 ? 120 : 40
  const movementAccountIds =
    isMother && !isCardPayable ? [accountId] : [accountId, ...related]

  const accountNames = new Map<string, string>()
  const accountMeta = new Map<string, AccountMeta>()
  accountNames.set(accountId, primaryName)
  accountMeta.set(accountId, {
    name: primaryName,
    kind: accountKind,
    chartCode: primaryChartCode,
  })
  if (related.length > 0) {
    const { data: nameRows } = await supabase
      .from("treasury_accounts")
      .select(
        `
        id,
        name,
        kind,
        accounting_chart_of_accounts ( code )
      `,
      )
      .eq("pop_id", popId)
      .in("id", related)
    for (const row of nameRows || []) {
      const id = String(row.id)
      const kind = parseTreasuryKind(row.kind)
      const chart = row.accounting_chart_of_accounts as unknown as {
        code?: string
      } | null
      accountNames.set(id, String(row.name ?? ""))
      accountMeta.set(id, {
        name: String(row.name ?? ""),
        kind,
        chartCode: String(chart?.code ?? ""),
      })
    }
  }

  const inDateRange = (iso: string) => {
    const d = iso.slice(0, 10)
    if (dateFrom && d < dateFrom) return false
    if (dateTo && d > dateTo) return false
    return true
  }

  const operational = await loadPopOperationalContext(supabase, popId, popSiteId)
  const timeZone = operational.timeZone

  const settlements: TreasurySettlementRow[] = []
  if (isCardPayable) {
    const { data: settleRows, error: settleErr } = await supabase
      .from("treasury_settlements")
      .select("id, amount, settled_at, notes, funding_treasury_account_id")
      .eq("pop_id", popId)
      .eq("card_treasury_account_id", accountId)
      .order("settled_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(50)
    if (settleErr) {
      return {
        success: false,
        error: settleErr.message || "No se pudieron cargar liquidaciones.",
        status: 500,
      }
    }
    const fundingIds = [
      ...new Set(
        (settleRows || [])
          .map((row) =>
            row.funding_treasury_account_id
              ? String(row.funding_treasury_account_id)
              : "",
          )
          .filter(Boolean),
      ),
    ]
    const fundingNames = new Map<string, string>()
    if (fundingIds.length > 0) {
      const { data: fundRows } = await supabase
        .from("treasury_accounts")
        .select("id, name")
        .eq("pop_id", popId)
        .in("id", fundingIds)
      for (const row of fundRows || []) {
        fundingNames.set(String(row.id), String(row.name ?? ""))
      }
    }
    for (const row of settleRows || []) {
      const fid =
        row.funding_treasury_account_id != null
          ? String(row.funding_treasury_account_id)
          : ""
      settlements.push({
        id: String(row.id),
        amount: parseMoney(row.amount),
        settledAt: String(row.settled_at ?? "").slice(0, 10),
        notes: String(row.notes ?? ""),
        fundingMethodName: fid ? (fundingNames.get(fid) ?? null) : null,
      })
    }
  }

  type Draft = Omit<
    TreasuryMovementRow,
    "movementRefId" | "reconciled" | "linkedStatementLineId" | "balanceImpact"
  >
  const drafts: Draft[] = []

  const { data: spRows, error: spErr } = await supabase
    .from("sale_payments")
    .select(
      `
      id,
      amount,
      sale_id,
      treasury_account_id,
      payment_kind,
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
    .in("treasury_account_id", movementAccountIds)
    .eq("sales.status", "completed")
    .limit(movementFetchLimit)
  if (spErr) {
    return {
      success: false,
      error: spErr.message || "No se pudieron cargar cobros.",
      status: 500,
    }
  }

  const labels = await loadSaleContextLabels(
    supabase,
    popId,
    (spRows || []).map((row) => {
      const sale = row.sales as unknown as {
        table_session_id?: string | null
        counter_order_id?: string | null
      } | null
      return {
        table_session_id: sale?.table_session_id,
        counter_order_id: sale?.counter_order_id,
      }
    }),
  )

  for (const row of spRows || []) {
    const sale = row.sales as unknown as {
      sold_at?: string
      customer_name?: string | null
      sale_channel?: string | null
      table_session_id?: string | null
      counter_order_id?: string | null
    } | null
    const sourceTaId =
      row.treasury_account_id != null ? String(row.treasury_account_id) : accountId
    const date = timestampToLocalDateIso(String(sale?.sold_at ?? ""), timeZone)
    if (!inDateRange(date)) continue
    const saleChannel = parseSaleChannel(sale?.sale_channel)
    const sessionId =
      sale?.table_session_id != null ? String(sale.table_session_id).trim() : ""
    const orderId =
      sale?.counter_order_id != null ? String(sale.counter_order_id).trim() : ""
    drafts.push({
      id: String(row.id),
      kind: "sale",
      date,
      occurredAt: String(sale?.sold_at ?? "").trim() || date,
      amount: parseMoney(row.amount),
      label: formatSaleLabel({
        saleChannel,
        tableLabel: sessionId ? labels.tables.get(sessionId) : null,
        counterOrderLabel: orderId ? labels.counters.get(orderId) : null,
        customerName: sale?.customer_name,
        paymentKind: parsePaymentKind(row.payment_kind),
      }),
      direction: "in",
      saleChannel,
      paymentKind: parsePaymentKind(row.payment_kind),
      treasuryAccountLabel: treasuryLabel(accountMeta.get(sourceTaId)),
      sourceAccountName:
        sourceTaId !== accountId ? (accountNames.get(sourceTaId) ?? null) : null,
    })
  }

  const { data: ppRows, error: ppErr } = await supabase
    .from("purchase_payments")
    .select(
      `
      id,
      amount,
      paid_at,
      created_at,
      treasury_account_id,
      payment_kind,
      purchases ( supplier_name, document_number, purchase_kind )
    `,
    )
    .eq("pop_id", popId)
    .in("treasury_account_id", movementAccountIds)
    .order("paid_at", { ascending: false })
    .limit(paymentOutFetchLimit)
  if (ppErr) {
    return {
      success: false,
      error: ppErr.message || "No se pudieron cargar pagos de compras.",
      status: 500,
    }
  }
  for (const row of ppRows || []) {
    const pur = row.purchases as unknown as {
      supplier_name?: string | null
      document_number?: string | null
      purchase_kind?: string | null
    } | null
    const sourceTaId =
      row.treasury_account_id != null ? String(row.treasury_account_id) : accountId
    const date = String(row.paid_at ?? "").slice(0, 10)
    if (!inDateRange(date)) continue
    drafts.push({
      id: String(row.id),
      kind: "purchase",
      date,
      occurredAt: String(row.created_at ?? row.paid_at ?? "").trim() || date,
      amount: parseMoney(row.amount),
      label: [
        "Compra",
        purchaseKindLabel(String(pur?.purchase_kind ?? "merchandise")),
        pur?.supplier_name?.trim() || "sin proveedor",
        ...(pur?.document_number?.trim() ? [pur.document_number.trim()] : []),
      ].join(", "),
      direction: "out",
      paymentKind: parsePaymentKind(row.payment_kind),
      treasuryAccountLabel: treasuryLabel(accountMeta.get(sourceTaId)),
      sourceAccountName:
        sourceTaId !== accountId ? (accountNames.get(sourceTaId) ?? null) : null,
    })
  }

  const { data: epRows, error: epErr } = await supabase
    .from("expense_payments")
    .select(
      `
      id,
      amount,
      paid_at,
      created_at,
      treasury_account_id,
      payment_kind,
      expenses ( description, expense_categories ( name ) )
    `,
    )
    .eq("pop_id", popId)
    .in("treasury_account_id", movementAccountIds)
    .order("paid_at", { ascending: false })
    .limit(paymentOutFetchLimit)
  if (epErr) {
    return {
      success: false,
      error: epErr.message || "No se pudieron cargar pagos de gastos.",
      status: 500,
    }
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
    const sourceTaId =
      row.treasury_account_id != null ? String(row.treasury_account_id) : accountId
    const date = String(row.paid_at ?? "").slice(0, 10)
    if (!inDateRange(date)) continue
    const parts = ["Gasto"]
    if (cat?.name?.trim()) parts.push(cat.name.trim())
    parts.push(exp?.description?.trim() || "sin detalle")
    drafts.push({
      id: String(row.id),
      kind: "expense",
      date,
      occurredAt: String(row.created_at ?? row.paid_at ?? "").trim() || date,
      amount: parseMoney(row.amount),
      label: parts.join(", "),
      direction: "out",
      paymentKind: parsePaymentKind(row.payment_kind),
      treasuryAccountLabel: treasuryLabel(accountMeta.get(sourceTaId)),
      sourceAccountName:
        sourceTaId !== accountId ? (accountNames.get(sourceTaId) ?? null) : null,
    })
  }

  const { data: empPayRows, error: empPayErr } = await supabase
    .from("pop_employee_payments")
    .select(
      `
      id,
      amount,
      paid_at,
      created_at,
      treasury_account_id,
      payment_kind,
      notes,
      pop_employees ( first_name, last_name )
    `,
    )
    .eq("pop_id", popId)
    .in("treasury_account_id", movementAccountIds)
    .order("paid_at", { ascending: false })
    .limit(paymentOutFetchLimit)
  if (empPayErr) {
    return {
      success: false,
      error: empPayErr.message || "No se pudieron cargar pagos de sueldos.",
      status: 500,
    }
  }
  for (const row of empPayRows || []) {
    const person = row.pop_employees as unknown as {
      first_name?: string | null
      last_name?: string | null
    } | null
    const personName =
      `${String(person?.first_name ?? "").trim()} ${String(person?.last_name ?? "").trim()}`.trim()
      || "Persona"
    const sourceTaId =
      row.treasury_account_id != null ? String(row.treasury_account_id) : accountId
    const date = String(row.paid_at ?? "").slice(0, 10)
    if (!inDateRange(date)) continue
    const note = String(row.notes ?? "").trim()
    drafts.push({
      id: String(row.id),
      kind: "employee_payment",
      date,
      occurredAt: String(row.created_at ?? row.paid_at ?? "").trim() || date,
      amount: parseMoney(row.amount),
      label: note ? `Sueldo, ${personName}, ${note}` : `Sueldo, ${personName}`,
      direction: "out",
      paymentKind: parsePaymentKind(row.payment_kind),
      treasuryAccountLabel: treasuryLabel(accountMeta.get(sourceTaId)),
      sourceAccountName:
        sourceTaId !== accountId ? (accountNames.get(sourceTaId) ?? null) : null,
    })
  }

  if (!isCardPayable) {
    const { data: fundSettleRows } = await supabase
      .from("treasury_settlements")
      .select(
        "id, amount, principal_amount, adjustment_amount, settled_at, created_at, card_treasury_account_id",
      )
      .eq("pop_id", popId)
      .eq("funding_treasury_account_id", accountId)
      .order("settled_at", { ascending: false })
      .limit(30)
    const cardIds = [
      ...new Set(
        (fundSettleRows || [])
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
      const { data: cardRows } = await supabase
        .from("treasury_accounts")
        .select("id, name")
        .eq("pop_id", popId)
        .in("id", cardIds)
      for (const row of cardRows || []) {
        cardNames.set(String(row.id), String(row.name ?? ""))
      }
    }
    for (const row of fundSettleRows || []) {
      const date = String(row.settled_at ?? "").slice(0, 10)
      if (!inDateRange(date)) continue
      const cid =
        row.card_treasury_account_id != null
          ? String(row.card_treasury_account_id)
          : ""
      drafts.push({
        id: `fund-${String(row.id)}`,
        kind: "funding_out",
        date,
        occurredAt: String(row.created_at ?? row.settled_at ?? "").trim() || date,
        amount: parseMoney(row.principal_amount ?? row.amount),
        label: `Resumen tarjeta — ${cardNames.get(cid) ?? "Tarjeta"}`,
        adjustmentAmount: parseMoney(row.adjustment_amount ?? 0),
        direction: "out",
        paymentKind: "transfer",
        treasuryAccountLabel: treasuryLabel(accountMeta.get(accountId)),
      })
    }

    const { data: posAcredRows } = await supabase
      .from("treasury_pos_acreditations")
      .select(
        "id, principal_amount, adjustment_amount, credited_at, created_at, notes, pos_treasury_account_id",
      )
      .eq("pop_id", popId)
      .eq("mother_treasury_account_id", accountId)
      .order("credited_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(120)
    const acredPosIds = [
      ...new Set(
        (posAcredRows || [])
          .map((row) =>
            row.pos_treasury_account_id
              ? String(row.pos_treasury_account_id)
              : "",
          )
          .filter(Boolean),
      ),
    ]
    const acredPosNames = new Map<string, string>()
    if (acredPosIds.length > 0) {
      const { data: nameRows } = await supabase
        .from("treasury_accounts")
        .select("id, name")
        .eq("pop_id", popId)
        .in("id", acredPosIds)
      for (const row of nameRows || []) {
        acredPosNames.set(String(row.id), String(row.name ?? ""))
      }
    }
    for (const row of posAcredRows || []) {
      const date = String(row.credited_at ?? "").slice(0, 10)
      if (!inDateRange(date)) continue
      const posId =
        row.pos_treasury_account_id != null
          ? String(row.pos_treasury_account_id)
          : ""
      const posName = acredPosNames.get(posId) ?? "POS"
      const principal = parseMoney(row.principal_amount)
      if (principal <= 0) continue
      drafts.push({
        id: String(row.id),
        kind: "pos_liquidation",
        date,
        occurredAt: String(row.created_at ?? row.credited_at ?? "").trim() || date,
        amount: principal,
        label: String(row.notes ?? "").trim() || `Recibido — ${posName}`,
        adjustmentAmount: parseMoney(row.adjustment_amount ?? 0),
        direction: "in",
        treasuryAccountLabel: posName,
        sourceAccountName: posName,
      })
    }
  }

  drafts.sort((a, b) => {
    const dc = (b.occurredAt ?? b.date).localeCompare(a.occurredAt ?? a.date)
    return dc !== 0 ? dc : b.id.localeCompare(a.id)
  })

  const supportsBankReconciliation = !isCardPayable && !isCashAccount
  const markByKey = new Map<string, { statementLineId: string | null }>()
  const linkedStatementIds = new Set<string>()
  let statementLines: BankStatementLineRow[] = []

  if (supportsBankReconciliation) {
    const { data: markRows } = await supabase
      .from("treasury_reconciliation_marks")
      .select("movement_kind, movement_ref_id, statement_line_id")
      .eq("pop_id", popId)
      .eq("treasury_account_id", accountId)
    for (const mark of markRows || []) {
      const sid =
        mark.statement_line_id != null ? String(mark.statement_line_id) : null
      markByKey.set(`${String(mark.movement_kind)}:${String(mark.movement_ref_id)}`, {
        statementLineId: sid,
      })
      if (sid) linkedStatementIds.add(sid)
    }

    const { data: stmtRows, error: stmtErr } = await supabase
      .from("bank_statement_lines")
      .select("id, line_date, description, amount, direction, source")
      .eq("pop_id", popId)
      .eq("treasury_account_id", accountId)
      .order("line_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100)
    if (stmtErr) {
      return {
        success: false,
        error: stmtErr.message || "No se pudo cargar el extracto bancario.",
        status: 500,
      }
    }
    statementLines = (stmtRows || []).map((row) => {
      const id = String(row.id)
      return {
        id,
        lineDate: String(row.line_date ?? "").slice(0, 10),
        description: String(row.description ?? ""),
        amount: parseMoney(row.amount),
        direction: String(row.direction) === "in" ? "in" : "out",
        source: String(row.source) === "csv" ? "csv" : "manual",
        reconciled: linkedStatementIds.has(id),
      }
    })
  }

  const displayLimit = isHeavy ? movementFetchLimit : related.length > 0 ? 100 : 60
  const withImpact = drafts.map((row) => ({
    ...row,
    balanceImpact: resolveImpact(row.kind, row.sourceAccountName),
  }))
  const real = withImpact
    .map((row) => {
      const refId = movementRefId(row.kind, row.id)
      const mark = markByKey.get(`${row.kind}:${refId}`)
      return {
        ...row,
        movementRefId: refId,
        reconciled: Boolean(mark),
        linkedStatementLineId: mark?.statementLineId ?? null,
      } satisfies TreasuryMovementRow
    })
    .filter((row) => row.balanceImpact === "real")

  let realIn = 0
  let realOut = 0
  for (const row of real) {
    if (row.direction === "in") realIn = roundMoney(realIn + row.amount)
    else realOut = roundMoney(realOut + row.amount)
  }

  let stmtIn = 0
  let stmtOut = 0
  let statementReconciled = 0
  for (const line of statementLines) {
    if (line.direction === "in") stmtIn = roundMoney(stmtIn + line.amount)
    else stmtOut = roundMoney(stmtOut + line.amount)
    if (line.reconciled) statementReconciled += 1
  }

  const movements = real.slice(0, displayLimit)
  const movementsReconciled = movements.filter((row) => row.reconciled).length

  return {
    success: true,
    data: {
      settlements,
      movements,
      movementTotals: {
        in: realIn,
        out: realOut,
        net: roundMoney(realIn - realOut),
      },
      statementLines,
      supportsBankReconciliation,
      reconciliationSummary: {
        movementsReconciled,
        movementsPending: movements.length - movementsReconciled,
        statementReconciled,
        statementPending: statementLines.length - statementReconciled,
        statementTotalIn: stmtIn,
        statementTotalOut: stmtOut,
      },
    },
  }
}
