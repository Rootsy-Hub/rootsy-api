import type { SupabaseClient } from "@supabase/supabase-js"
import { readCheckoutFromSessionMetadata } from "./checkout.js"
import {
  loadArcaBySaleIds,
  loadCounterOrderLabelsBySaleIds,
  loadPurchaseDocumentKindsByPurchaseIds,
  loadTableLabelsBySaleIds,
  loadUserDisplayNames,
  PURCHASE_DETAIL_SELECT,
  SALE_DETAIL_SELECT,
} from "./loaders.js"
import {
  mapPurchaseRows,
  mapSaleRows,
  mapSaleToChargeRow,
  parseCounterOrderLabel,
  parseMoney,
  parseTableLabelFromSession,
  resolveSaleChannelFromRow,
} from "./mappers.js"
import type {
  OperationAccountingEntryDetail,
  OperationAccountingLineRow,
  OperationPurchaseRow,
  OperationSaleChargeRow,
  OperationSaleDetailContext,
  OperationSaleRow,
  OperationsListView,
} from "./schema.js"

export async function loadOperationSaleDetailContext(
  supabase: SupabaseClient,
  popId: string,
  row: Record<string, unknown>,
  tableLabelBySessionId: Map<string, string>,
  counterOrderLabelByOrderId: Map<string, string>,
): Promise<OperationSaleDetailContext> {
  const channel = resolveSaleChannelFromRow(row)
  const soldAt = row.sold_at != null ? String(row.sold_at) : null
  const customerName =
    row.customer_name != null ? String(row.customer_name).trim() || null : null
  const createdBy =
    row.created_by != null ? String(row.created_by).trim() || null : null

  const base: OperationSaleDetailContext = {
    channel,
    soldAt,
    soldByName: null,
    customerName,
    tableLabel: parseTableLabelFromSession(row, tableLabelBySessionId),
    openedAt: null,
    closedAt: null,
    openedByName: null,
    closedByName: null,
    waiterName: null,
    guestCount: null,
    note: null,
    counterOrderLabel: parseCounterOrderLabel(row, counterOrderLabelByOrderId),
    fulfillmentType: null,
    deliveryAddress: null,
    phone: null,
    driverName: null,
    estimatedMinutes: null,
    deliveredAt: null,
  }

  const userIds = new Set<string>()
  if (createdBy) userIds.add(createdBy)

  const tableSessionId =
    row.table_session_id != null ? String(row.table_session_id).trim() : ""
  const counterOrderId =
    row.counter_order_id != null ? String(row.counter_order_id).trim() : ""

  let tableOpenedBy: string | null = null
  let tableClosedBy: string | null = null
  let tableWaiterId: string | null = null
  let counterOpenedBy: string | null = null
  let counterClosedBy: string | null = null
  let counterStatus: string | null = null
  let counterCancelledAt: string | null = null

  if (channel === "table" && tableSessionId) {
    const { data: session } = await supabase
      .from("table_sessions")
      .select(
        `
        waiter_user_id,
        guest_count,
        notes,
        opened_at,
        closed_at,
        opened_by,
        closed_by
      `,
      )
      .eq("id", tableSessionId)
      .eq("pop_id", popId)
      .maybeSingle()

    if (session) {
      base.openedAt =
        session.opened_at != null ? String(session.opened_at) : null
      base.closedAt =
        session.closed_at != null ? String(session.closed_at) : null
      base.guestCount =
        session.guest_count != null ? Number(session.guest_count) : null
      base.note =
        session.notes != null ? String(session.notes).trim() || null : null
      tableWaiterId =
        session.waiter_user_id != null
          ? String(session.waiter_user_id).trim() || null
          : null
      tableOpenedBy =
        session.opened_by != null
          ? String(session.opened_by).trim() || null
          : null
      tableClosedBy =
        session.closed_by != null
          ? String(session.closed_by).trim() || null
          : null
      if (tableWaiterId) userIds.add(tableWaiterId)
      if (tableOpenedBy) userIds.add(tableOpenedBy)
      if (tableClosedBy) userIds.add(tableClosedBy)
    }
  }

  if (channel === "counter" && counterOrderId) {
    const { data: order } = await supabase
      .from("counter_orders")
      .select(
        `
        order_number,
        status,
        fulfillment_type,
        delivery_address,
        phone,
        driver_name,
        estimated_minutes,
        notes,
        opened_at,
        delivered_at,
        cancelled_at,
        opened_by,
        cancelled_by
      `,
      )
      .eq("id", counterOrderId)
      .eq("pop_id", popId)
      .maybeSingle()

    if (order) {
      const orderNumber = Number(order.order_number)
      if (Number.isFinite(orderNumber) && !base.counterOrderLabel) {
        base.counterOrderLabel = `#${orderNumber}`
      }
      counterStatus = order.status != null ? String(order.status) : null
      base.openedAt = order.opened_at != null ? String(order.opened_at) : null
      base.deliveredAt =
        order.delivered_at != null ? String(order.delivered_at) : null
      counterCancelledAt =
        order.cancelled_at != null ? String(order.cancelled_at) : null
      const fulfillment = String(order.fulfillment_type ?? "").trim()
      base.fulfillmentType =
        fulfillment === "delivery" || fulfillment === "pickup"
          ? fulfillment
          : null
      base.deliveryAddress =
        order.delivery_address != null
          ? String(order.delivery_address).trim() || null
          : null
      base.phone =
        order.phone != null ? String(order.phone).trim() || null : null
      base.driverName =
        order.driver_name != null
          ? String(order.driver_name).trim() || null
          : null
      base.estimatedMinutes =
        order.estimated_minutes != null
          ? Number(order.estimated_minutes)
          : null
      base.note =
        order.notes != null ? String(order.notes).trim() || null : null
      counterOpenedBy =
        order.opened_by != null
          ? String(order.opened_by).trim() || null
          : null
      counterClosedBy =
        order.cancelled_by != null
          ? String(order.cancelled_by).trim() || null
          : null
      if (counterOpenedBy) userIds.add(counterOpenedBy)
      if (counterClosedBy) userIds.add(counterClosedBy)
      if (counterStatus === "cancelled" && counterCancelledAt) {
        base.closedAt = counterCancelledAt
      } else if (base.deliveredAt) {
        base.closedAt = base.deliveredAt
      } else if (soldAt) {
        base.closedAt = soldAt
      }
    }
  }

  const userNames = await loadUserDisplayNames(supabase, [...userIds])

  if (channel === "table") {
    base.openedByName = tableOpenedBy
      ? (userNames.get(tableOpenedBy) ?? null)
      : null
    base.closedByName = tableClosedBy
      ? (userNames.get(tableClosedBy) ?? null)
      : null
    base.waiterName = tableWaiterId
      ? (userNames.get(tableWaiterId) ?? null)
      : null
  }

  if (channel === "counter") {
    base.openedByName = counterOpenedBy
      ? (userNames.get(counterOpenedBy) ?? null)
      : null
    if (counterStatus === "cancelled" && counterClosedBy) {
      base.closedByName = userNames.get(counterClosedBy) ?? null
    } else if (createdBy) {
      base.closedByName = userNames.get(createdBy) ?? null
    }
  }

  if (createdBy) {
    base.soldByName = userNames.get(createdBy) ?? null
  }

  return base
}

function mapAccountingEntryLines(
  lines: Array<Record<string, unknown>>,
): OperationAccountingLineRow[] {
  return lines.map((r) => {
    const acc = r.accounting_chart_of_accounts as unknown as {
      code?: string
      name?: string
    } | null
    return {
      id: String(r.id),
      accountCode: acc?.code ? String(acc.code) : "—",
      accountName: acc?.name ? String(acc.name) : "—",
      debitAmount: parseMoney(r.debit_amount),
      creditAmount: parseMoney(r.credit_amount),
      lineDescription: r.description != null ? String(r.description) : null,
    }
  })
}

async function fetchAccountingEntryDetails(
  supabase: SupabaseClient,
  _popId: string,
  entryRows: Array<Record<string, unknown>>,
): Promise<OperationAccountingEntryDetail[]> {
  if (entryRows.length === 0) return []

  const entryIds = entryRows.map((e) => String(e.id))
  const { data: lineRows, error: lineErr } = await supabase
    .from("accounting_entry_lines")
    .select(
      `
        id,
        entry_id,
        debit_amount,
        credit_amount,
        description,
        line_order,
        accounting_chart_of_accounts ( code, name )
      `,
    )
    .in("entry_id", entryIds)
    .order("line_order", { ascending: true })

  if (lineErr) {
    throw new Error(lineErr.message || "No se pudieron cargar las líneas.")
  }

  const linesByEntry = new Map<string, OperationAccountingLineRow[]>()
  const debitByEntry = new Map<string, number>()
  const creditByEntry = new Map<string, number>()

  for (const raw of lineRows || []) {
    const row = raw as Record<string, unknown>
    const entryId = String(row.entry_id)
    const mapped = mapAccountingEntryLines([row])[0]
    const list = linesByEntry.get(entryId) ?? []
    list.push(mapped)
    linesByEntry.set(entryId, list)
    debitByEntry.set(
      entryId,
      parseMoney(debitByEntry.get(entryId) ?? 0) + mapped.debitAmount,
    )
    creditByEntry.set(
      entryId,
      parseMoney(creditByEntry.get(entryId) ?? 0) + mapped.creditAmount,
    )
  }

  return entryRows.map((e) => {
    const id = String(e.id)
    return {
      id,
      entryNumber: Number(e.entry_number ?? 0),
      entryDate: String(e.entry_date ?? "").slice(0, 10),
      description: String(e.description ?? ""),
      sourceType: String(e.source_type ?? ""),
      status: String(e.status ?? ""),
      totalDebit: parseMoney(debitByEntry.get(id) ?? 0),
      totalCredit: parseMoney(creditByEntry.get(id) ?? 0),
      lines: linesByEntry.get(id) ?? [],
    }
  })
}

export async function getOperationAccountingEntries(
  supabase: SupabaseClient,
  popId: string,
  input: {
    view: OperationsListView
    operationId: string
    groupedSaleIds?: string[]
  },
): Promise<
  | { success: true; data: { entries: OperationAccountingEntryDetail[] } }
  | { success: false; error: string }
> {
  try {
    const { view, operationId } = input
    let entryRows: Array<Record<string, unknown>> = []

    if (view === "sales" || view === "tables" || view === "counter") {
      const saleIds =
        input.groupedSaleIds && input.groupedSaleIds.length > 0
          ? input.groupedSaleIds
          : [operationId]
      const { data, error } = await supabase
        .from("accounting_entries")
        .select(
          "id, entry_number, entry_date, description, source_type, status",
        )
        .eq("pop_id", popId)
        .eq("source_type", "sale")
        .in("source_id", saleIds)
        .neq("status", "cancelled")
        .order("entry_number", { ascending: true })
      if (error) {
        return {
          success: false,
          error: error.message || "No se pudieron cargar los asientos.",
        }
      }
      entryRows = (data || []) as Array<Record<string, unknown>>
    } else if (view === "purchases") {
      const { data: purchaseEntries, error: purchaseErr } = await supabase
        .from("accounting_entries")
        .select(
          "id, entry_number, entry_date, description, source_type, status",
        )
        .eq("pop_id", popId)
        .eq("source_type", "purchase")
        .eq("source_id", operationId)
        .neq("status", "cancelled")
      if (purchaseErr) {
        return {
          success: false,
          error: purchaseErr.message || "No se pudieron cargar los asientos.",
        }
      }

      const { data: paymentRows, error: payErr } = await supabase
        .from("purchase_payments")
        .select("id")
        .eq("pop_id", popId)
        .eq("purchase_id", operationId)
      if (payErr) {
        return {
          success: false,
          error: payErr.message || "No se pudieron cargar los pagos.",
        }
      }

      const paymentIds = (paymentRows || []).map((p) => String(p.id))
      let paymentEntries: Array<Record<string, unknown>> = []
      if (paymentIds.length > 0) {
        const { data, error } = await supabase
          .from("accounting_entries")
          .select(
            "id, entry_number, entry_date, description, source_type, status",
          )
          .eq("pop_id", popId)
          .eq("source_type", "purchase_payment")
          .in("source_id", paymentIds)
          .neq("status", "cancelled")
        if (error) {
          return {
            success: false,
            error: error.message || "No se pudieron cargar los asientos.",
          }
        }
        paymentEntries = (data || []) as Array<Record<string, unknown>>
      }

      entryRows = [
        ...((purchaseEntries || []) as Array<Record<string, unknown>>),
        ...paymentEntries,
      ].sort(
        (a, b) =>
          Number(a.entry_number ?? 0) - Number(b.entry_number ?? 0) ||
          String(a.entry_date ?? "").localeCompare(String(b.entry_date ?? "")),
      )
    } else {
      const { data, error } = await supabase
        .from("accounting_entries")
        .select(
          "id, entry_number, entry_date, description, source_type, status",
        )
        .eq("pop_id", popId)
        .eq("id", operationId)
        .neq("status", "cancelled")
        .maybeSingle()
      if (error) {
        return {
          success: false,
          error: error.message || "No se pudieron cargar los asientos.",
        }
      }
      entryRows = data ? [data as Record<string, unknown>] : []
    }

    const entries = await fetchAccountingEntryDetails(
      supabase,
      popId,
      entryRows,
    )
    return { success: true, data: { entries } }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error desconocido"
    return { success: false, error: message }
  }
}

export async function getOperationSaleById(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  saleId: string,
): Promise<
  | {
      success: true
      data: { sale: OperationSaleRow; context: OperationSaleDetailContext }
    }
  | { success: false; error: string }
> {
  try {
    const trimmedSaleId = saleId.trim()
    if (!trimmedSaleId) {
      return { success: false, error: "Venta inválida." }
    }

    const fiscalSiteId = popSiteId
    const { data: row, error } = await supabase
      .from("sales")
      .select(SALE_DETAIL_SELECT)
      .eq("pop_id", popId)
      .eq("id", trimmedSaleId)
      .maybeSingle()

    if (error || !row) {
      return {
        success: false,
        error: error?.message || "No se encontró la venta.",
      }
    }

    const saleChannel = String(row.sale_channel ?? "")
    const arcaBySaleId = await loadArcaBySaleIds(
      supabase,
      popId,
      fiscalSiteId,
      [trimmedSaleId],
    )
    const tableLabelBySessionId =
      saleChannel === "table"
        ? await loadTableLabelsBySaleIds(supabase, popId, [
            row as Record<string, unknown>,
          ])
        : new Map<string, string>()
    const counterOrderLabelByOrderId =
      saleChannel === "counter"
        ? await loadCounterOrderLabelsBySaleIds(supabase, popId, [
            row as Record<string, unknown>,
          ])
        : new Map<string, string>()

    const userNames = await loadUserDisplayNames(
      supabase,
      row.created_by != null ? [String(row.created_by).trim()] : [],
    )

    const sales = mapSaleRows(
      [row as Record<string, unknown>],
      arcaBySaleId,
      fiscalSiteId,
      tableLabelBySessionId,
      counterOrderLabelByOrderId,
      userNames,
    )
    const sale = sales[0]
    if (!sale) {
      return { success: false, error: "No se encontró la venta." }
    }

    const context = await loadOperationSaleDetailContext(
      supabase,
      popId,
      row as Record<string, unknown>,
      tableLabelBySessionId,
      counterOrderLabelByOrderId,
    )

    return { success: true, data: { sale, context } }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error desconocido"
    return { success: false, error: message }
  }
}

export async function getOperationPurchaseById(
  supabase: SupabaseClient,
  popId: string,
  purchaseId: string,
): Promise<
  | { success: true; data: { purchase: OperationPurchaseRow } }
  | { success: false; error: string }
> {
  try {
    const trimmed = purchaseId.trim()
    if (!trimmed) {
      return { success: false, error: "Compra inválida." }
    }

    const { data: row, error } = await supabase
      .from("purchases")
      .select(PURCHASE_DETAIL_SELECT)
      .eq("pop_id", popId)
      .eq("id", trimmed)
      .maybeSingle()

    if (error || !row) {
      return {
        success: false,
        error: error?.message || "No se encontró la compra.",
      }
    }

    const userNames = await loadUserDisplayNames(
      supabase,
      row.created_by != null ? [String(row.created_by).trim()] : [],
    )
    const documentKindByPurchaseId =
      await loadPurchaseDocumentKindsByPurchaseIds(supabase, popId, [trimmed])
    const purchases = mapPurchaseRows(
      [row as Record<string, unknown>],
      userNames,
      documentKindByPurchaseId,
    )
    const purchase = purchases[0]
    if (!purchase) {
      return { success: false, error: "No se encontró la compra." }
    }
    return { success: true, data: { purchase } }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error desconocido"
    return { success: false, error: message }
  }
}

async function resolveOperationChargeSaleIds(
  supabase: SupabaseClient,
  popId: string,
  input: {
    saleId: string
    groupedSaleIds?: string[]
    tableSessionId?: string | null
    counterOrderId?: string | null
  },
): Promise<{ ok: true; saleIds: string[] } | { ok: false; error: string }> {
  const uniqueIds = (ids: string[]) =>
    [...new Set(ids.map((id) => id.trim()).filter(Boolean))]

  if (input.groupedSaleIds?.length) {
    return { ok: true, saleIds: uniqueIds(input.groupedSaleIds) }
  }

  let sessionId = input.tableSessionId?.trim() || ""
  let orderId = input.counterOrderId?.trim() || ""

  if (!sessionId && !orderId) {
    const { data, error } = await supabase
      .from("sales")
      .select("id, table_session_id, counter_order_id")
      .eq("pop_id", popId)
      .eq("id", input.saleId)
      .maybeSingle()
    if (error || !data) {
      return {
        ok: false,
        error: error?.message || "No se encontró la venta.",
      }
    }
    sessionId =
      data.table_session_id != null ? String(data.table_session_id).trim() : ""
    orderId =
      data.counter_order_id != null ? String(data.counter_order_id).trim() : ""
  }

  if (!sessionId && !orderId) {
    return { ok: true, saleIds: [input.saleId] }
  }

  let query = supabase
    .from("sales")
    .select("id")
    .eq("pop_id", popId)
    .neq("status", "cancelled")
  query = sessionId
    ? query.eq("table_session_id", sessionId)
    : query.eq("counter_order_id", orderId)

  const { data, error } = await query
  if (error) return { ok: false, error: error.message }

  const saleIds = uniqueIds((data ?? []).map((row) => String(row.id)))
  return { ok: true, saleIds: saleIds.length > 0 ? saleIds : [input.saleId] }
}

export async function getOperationSaleDetailCharges(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
  input: {
    saleId: string
    groupedSaleIds?: string[]
    tableSessionId?: string | null
    counterOrderId?: string | null
  },
): Promise<
  | { success: true; data: { charges: OperationSaleChargeRow[] } }
  | { success: false; error: string }
> {
  try {
    const primarySaleId = input.saleId.trim()
    if (!primarySaleId) {
      return { success: false, error: "Venta inválida." }
    }

    const fiscalSiteId = popSiteId
    const resolvedIds = await resolveOperationChargeSaleIds(supabase, popId, {
      saleId: primarySaleId,
      groupedSaleIds: input.groupedSaleIds,
      tableSessionId: input.tableSessionId,
      counterOrderId: input.counterOrderId,
    })
    if (!resolvedIds.ok) {
      return { success: false, error: resolvedIds.error }
    }
    const saleIds = resolvedIds.saleIds

    const { data: rows, error } = await supabase
      .from("sales")
      .select(SALE_DETAIL_SELECT)
      .eq("pop_id", popId)
      .in("id", saleIds)
      .neq("status", "cancelled")

    if (error) {
      return { success: false, error: error.message }
    }
    if (!rows?.length) {
      return { success: false, error: "No se encontraron cobros." }
    }

    const arcaBySaleId = await loadArcaBySaleIds(
      supabase,
      popId,
      fiscalSiteId,
      saleIds,
    )
    const tableLabelBySessionId = await loadTableLabelsBySaleIds(
      supabase,
      popId,
      rows as Array<Record<string, unknown>>,
    )
    const counterOrderLabelByOrderId = await loadCounterOrderLabelsBySaleIds(
      supabase,
      popId,
      rows as Array<Record<string, unknown>>,
    )

    const userNames = await loadUserDisplayNames(
      supabase,
      (rows || [])
        .map((row) =>
          row.created_by != null ? String(row.created_by).trim() : "",
        )
        .filter(Boolean),
    )

    const sales = mapSaleRows(
      rows as Array<Record<string, unknown>>,
      arcaBySaleId,
      fiscalSiteId,
      tableLabelBySessionId,
      counterOrderLabelByOrderId,
      userNames,
    ).sort((a, b) => a.soldAt.localeCompare(b.soldAt))

    return {
      success: true,
      data: { charges: sales.map(mapSaleToChargeRow) },
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error desconocido"
    return { success: false, error: message }
  }
}

export async function getOperationSaleDetailContext(
  supabase: SupabaseClient,
  popId: string,
  saleId: string,
): Promise<
  | { success: true; data: { context: OperationSaleDetailContext } }
  | { success: false; error: string }
> {
  try {
    const trimmedSaleId = saleId.trim()
    if (!trimmedSaleId) {
      return { success: false, error: "Venta inválida." }
    }

    const { data: row, error } = await supabase
      .from("sales")
      .select(
        `
        id,
        sold_at,
        customer_name,
        created_by,
        sale_channel,
        table_session_id,
        counter_order_id
      `,
      )
      .eq("pop_id", popId)
      .eq("id", trimmedSaleId)
      .maybeSingle()

    if (error || !row) {
      return {
        success: false,
        error: error?.message || "No se encontró la venta.",
      }
    }

    const saleChannel = String(row.sale_channel ?? "")
    const tableLabelBySessionId =
      saleChannel === "table"
        ? await loadTableLabelsBySaleIds(supabase, popId, [
            row as Record<string, unknown>,
          ])
        : new Map<string, string>()
    const counterOrderLabelByOrderId =
      saleChannel === "counter"
        ? await loadCounterOrderLabelsBySaleIds(supabase, popId, [
            row as Record<string, unknown>,
          ])
        : new Map<string, string>()

    const context = await loadOperationSaleDetailContext(
      supabase,
      popId,
      row as Record<string, unknown>,
      tableLabelBySessionId,
      counterOrderLabelByOrderId,
    )

    return { success: true, data: { context } }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error desconocido"
    return { success: false, error: message }
  }
}

export async function getChannelOperationTicketDisplay(
  supabase: SupabaseClient,
  popId: string,
  input: {
    tableSessionId?: string | null
    counterOrderId?: string | null
  },
): Promise<
  | { success: true; data: { checkout: ReturnType<typeof readCheckoutFromSessionMetadata> } }
  | { success: false; error: string }
> {
  try {
    const tableSessionId = input.tableSessionId?.trim() || null
    const counterOrderId = input.counterOrderId?.trim() || null
    if (!tableSessionId && !counterOrderId) {
      return { success: false, error: "Operación de canal inválida." }
    }

    let metadata: unknown = null

    if (tableSessionId) {
      const { data, error } = await supabase
        .from("table_sessions")
        .select("metadata")
        .eq("id", tableSessionId)
        .eq("pop_id", popId)
        .maybeSingle()
      if (error || !data) {
        return {
          success: false,
          error: error?.message || "No se encontró la sesión de mesa.",
        }
      }
      metadata = data.metadata
    } else {
      const { data, error } = await supabase
        .from("counter_orders")
        .select("metadata")
        .eq("id", counterOrderId!)
        .eq("pop_id", popId)
        .maybeSingle()
      if (error || !data) {
        return {
          success: false,
          error: error?.message || "No se encontró el pedido de mostrador.",
        }
      }
      metadata = data.metadata
    }

    const checkout = readCheckoutFromSessionMetadata(metadata)
    if (!checkout?.carrito?.length) {
      return {
        success: false,
        error: "No hay ticket guardado para esta operación.",
      }
    }

    return { success: true, data: { checkout } }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Error desconocido"
    return { success: false, error: message }
  }
}
