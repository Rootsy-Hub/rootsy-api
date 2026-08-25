import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { auditedInsert, auditedUpdate } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import { syncComandasFromCounterCheckout } from "./comandasSync.js"
import {
  checkoutFromMetadata,
  mapCounterOrderRow,
  nextOrderNumber,
  validateCreateInput,
} from "./queries.js"
import {
  COUNTER_ORDER_SELECT,
  type CounterFulfillmentType,
  type CounterOrder,
  type CounterOrderStatus,
  type CreateCounterOrderBody,
  type PatchCounterOrderBody,
} from "./schema.js"

type MutateResult =
  | { success: true; data: { order?: CounterOrder; updatedAt?: string } }
  | { success: false; error: string; status: 400 | 404 | 500 }

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v != null && !Array.isArray(v)
}

function checkoutHasPayment(checkout: Record<string, unknown> | null): boolean {
  if (!checkout) return false
  const total = Number(checkout.totalPagadoAcumulado ?? 0)
  if (total > 0) return true
  const units = checkout.paidPartialUnits
  if (!isRecord(units)) return false
  return Object.values(units).some((value) => Number(value) > 0)
}

async function loadOrderRow(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
) {
  return supabase
    .from("counter_orders")
    .select(COUNTER_ORDER_SELECT)
    .eq("id", orderId)
    .eq("pop_id", popId)
    .maybeSingle()
}

export async function createCounterOrder(
  supabase: SupabaseClient,
  popId: string,
  userId: string,
  input: CreateCounterOrderBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const validationError = validateCreateInput(input)
  if (validationError) {
    return { success: false, error: validationError, status: 400 }
  }

  const id = randomUUID()
  const orderDay = todayIsoDate()
  const orderNumber = await nextOrderNumber(supabase, popId)
  const immediate = Boolean(input.immediateFulfillment)
  const status: CounterOrderStatus = immediate ? "delivered" : "preparing"
  const now = new Date().toISOString()
  const row = {
    id,
    pop_id: popId,
    order_day: orderDay,
    order_number: orderNumber,
    status,
    fulfillment_type: input.fulfillmentType,
    delivery_address:
      input.fulfillmentType === "delivery"
        ? input.deliveryAddress?.trim() ?? ""
        : null,
    phone:
      input.fulfillmentType === "delivery" ? input.phone?.trim() ?? "" : null,
    driver_name: input.driverName?.trim() || null,
    estimated_minutes: input.estimatedMinutes,
    notes: input.notes?.trim() ?? "",
    immediate_fulfillment: immediate,
    delivered_at: immediate ? now : null,
    opened_by: userId,
  }

  const applied = await auditedInsert(supabase, {
    kind: "mostrador.create",
    table: "counter_orders",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  const { data, error } = await loadOrderRow(supabase, popId, id)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer el pedido creado.",
      status: 500,
    }
  }
  return {
    success: true,
    data: {
      order: mapCounterOrderRow(data as Parameters<typeof mapCounterOrderRow>[0]),
    },
  }
}

export async function updateCounterOrder(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
  input: PatchCounterOrderBody,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing, error: existingErr } = await loadOrderRow(
    supabase,
    popId,
    orderId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing || existing.status === "cancelled") {
    return {
      success: false,
      error: "El pedido no existe o fue cancelado.",
      status: 404,
    }
  }
  const current = mapCounterOrderRow(
    existing as Parameters<typeof mapCounterOrderRow>[0],
  )
  if (current.saleId) {
    return {
      success: false,
      error: "No se puede editar un pedido ya cobrado.",
      status: 400,
    }
  }

  const fulfillmentType =
    input.fulfillmentType ?? current.fulfillmentType
  const merged = {
    fulfillmentType,
    deliveryAddress: input.deliveryAddress ?? current.deliveryAddress,
    phone: input.phone ?? current.phone,
    driverName: input.driverName ?? current.driverName,
    estimatedMinutes: input.estimatedMinutes ?? current.estimatedMinutes,
    notes: input.notes ?? current.notes,
  }
  const validationError = validateCreateInput(merged)
  if (validationError) {
    return { success: false, error: validationError, status: 400 }
  }

  const patch = {
    fulfillment_type: fulfillmentType,
    delivery_address:
      fulfillmentType === "delivery"
        ? merged.deliveryAddress?.trim() ?? ""
        : null,
    phone: fulfillmentType === "delivery" ? merged.phone?.trim() ?? "" : null,
    driver_name: merged.driverName?.trim() || null,
    estimated_minutes: merged.estimatedMinutes,
    notes: merged.notes?.trim() ?? "",
  }
  const applied = await auditedUpdate(supabase, {
    kind: "mostrador.update",
    table: "counter_orders",
    id: orderId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadOrderRow(supabase, popId, orderId)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer el pedido.",
      status: 500,
    }
  }
  return {
    success: true,
    data: {
      order: mapCounterOrderRow(data as Parameters<typeof mapCounterOrderRow>[0]),
    },
  }
}

export async function updateCounterOrderStatus(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
  status: CounterOrderStatus,
  userId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing, error: existingErr } = await loadOrderRow(
    supabase,
    popId,
    orderId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing || existing.status === "cancelled") {
    return { success: false, error: "El pedido no existe.", status: 404 }
  }

  if (status === "cancelled") {
    return cancelCounterOrder(supabase, popId, orderId, userId, audit)
  }

  const fulfillmentType = String(existing.fulfillment_type) as CounterFulfillmentType
  if (status === "dispatched" && fulfillmentType !== "delivery") {
    return {
      success: false,
      error: "Solo los pedidos delivery pueden marcarse como enviados.",
      status: 400,
    }
  }
  const validStatuses: CounterOrderStatus[] =
    fulfillmentType === "delivery"
      ? ["preparing", "dispatched", "delivered"]
      : ["preparing", "delivered"]
  if (!validStatuses.includes(status)) {
    return {
      success: false,
      error: "Estado no permitido para este pedido.",
      status: 400,
    }
  }

  if (String(existing.status) === status) {
    return {
      success: true,
      data: {
        order: mapCounterOrderRow(
          existing as Parameters<typeof mapCounterOrderRow>[0],
        ),
      },
    }
  }

  const patch: Record<string, unknown> = {
    status,
    delivered_at: status === "delivered" ? new Date().toISOString() : null,
  }
  const applied = await auditedUpdate(supabase, {
    kind: "mostrador.update",
    table: "counter_orders",
    id: orderId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadOrderRow(supabase, popId, orderId)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer el pedido.",
      status: 500,
    }
  }
  return {
    success: true,
    data: {
      order: mapCounterOrderRow(data as Parameters<typeof mapCounterOrderRow>[0]),
    },
  }
}

export async function cancelCounterOrder(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
  userId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing, error: existingErr } = await loadOrderRow(
    supabase,
    popId,
    orderId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing || existing.status === "cancelled") {
    return {
      success: false,
      error: "No se puede cancelar este pedido (cobrado o inexistente).",
      status: 404,
    }
  }
  if (existing.sale_id) {
    return {
      success: false,
      error: "No se puede cancelar un pedido ya cobrado.",
      status: 400,
    }
  }
  const checkout = checkoutFromMetadata(existing.metadata)
  if (checkoutHasPayment(checkout)) {
    return {
      success: false,
      error:
        "No se puede cancelar un pedido con cobros registrados. Terminá el cobro o cerrá el pedido.",
      status: 400,
    }
  }

  const { count: salesCount, error: salesCountErr } = await supabase
    .from("sales")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("counter_order_id", orderId)
    .eq("status", "completed")
  if (salesCountErr) {
    return { success: false, error: salesCountErr.message, status: 500 }
  }
  if ((salesCount ?? 0) > 0) {
    return {
      success: false,
      error:
        "No se puede cancelar un pedido con ventas registradas. Cerrá el pedido desde el carrito.",
      status: 400,
    }
  }

  const patch = {
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
    cancelled_by: userId,
  }
  const applied = await auditedUpdate(supabase, {
    kind: "mostrador.update",
    table: "counter_orders",
    id: orderId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, data: {} }
}

export async function saveCounterOrderCheckout(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
  checkout: Record<string, unknown>,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing, error: existingErr } = await loadOrderRow(
    supabase,
    popId,
    orderId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing || existing.status === "cancelled") {
    return { success: false, error: "El pedido no existe.", status: 404 }
  }
  if (existing.sale_id) {
    return {
      success: false,
      error: "No se puede modificar un pedido ya cobrado.",
      status: 400,
    }
  }

  const metadata =
    existing.metadata && isRecord(existing.metadata)
      ? { ...existing.metadata }
      : {}
  metadata.checkout = checkout
  const applied = await auditedUpdate(supabase, {
    kind: "mostrador.update",
    table: "counter_orders",
    id: orderId,
    row: { metadata },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, metadata },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  await syncComandasFromCounterCheckout(supabase, popId, orderId, checkout)

  const { data, error } = await supabase
    .from("counter_orders")
    .select("updated_at")
    .eq("id", orderId)
    .eq("pop_id", popId)
    .single()
  if (error || !data?.updated_at) {
    return {
      success: false,
      error: error?.message || "No se pudo guardar el pedido.",
      status: 500,
    }
  }
  return {
    success: true,
    data: { updatedAt: String(data.updated_at) },
  }
}

export async function closeCounterOrder(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
  mode: "settle" | "release",
  userId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  if (mode === "release") {
    const { data: existing, error: existingErr } = await loadOrderRow(
      supabase,
      popId,
      orderId,
    )
    if (existingErr) {
      return { success: false, error: existingErr.message, status: 500 }
    }
    if (!existing || existing.status === "cancelled") {
      return {
        success: false,
        error: "El pedido no existe o fue cancelado.",
        status: 404,
      }
    }
    if (existing.sale_id) return { success: true, data: {} }

    const checkout = checkoutFromMetadata(existing.metadata)
    const carrito = Array.isArray(checkout?.carrito) ? checkout.carrito : []
    if (carrito.length > 0) {
      return {
        success: false,
        error: "Hay ítems sin cobrar. Cobrá el pedido antes de cerrar.",
        status: 400,
      }
    }
    if (checkoutHasPayment(checkout)) {
      return {
        success: false,
        error:
          "Hay cobros registrados en el pedido. Terminá el cobro antes de cerrar.",
        status: 400,
      }
    }
    const { count: salesCount, error: salesCountErr } = await supabase
      .from("sales")
      .select("id", { count: "exact", head: true })
      .eq("pop_id", popId)
      .eq("counter_order_id", orderId)
      .eq("status", "completed")
    if (salesCountErr) {
      return { success: false, error: salesCountErr.message, status: 500 }
    }
    if ((salesCount ?? 0) > 0) {
      return {
        success: false,
        error:
          "Hay ventas registradas para este pedido. No se puede liberar sin cerrar el cobro.",
        status: 400,
      }
    }
    return cancelCounterOrder(supabase, popId, orderId, userId, audit)
  }

  return finalizeCounterOrder(supabase, popId, orderId, audit)
}

async function finalizeCounterOrder(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
  audit: MutationAuditCtx,
): Promise<MutateResult> {
  const { data: existing, error: existingErr } = await loadOrderRow(
    supabase,
    popId,
    orderId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing || existing.status === "cancelled") {
    return {
      success: false,
      error: "El pedido no existe o fue cancelado.",
      status: 404,
    }
  }
  if (existing.sale_id) return { success: true, data: {} }

  const { data: latestSale, error: saleErr } = await supabase
    .from("sales")
    .select("id, metadata")
    .eq("pop_id", popId)
    .eq("counter_order_id", orderId)
    .eq("status", "completed")
    .order("sold_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (saleErr) {
    return { success: false, error: saleErr.message, status: 500 }
  }
  if (!latestSale?.id) {
    return {
      success: false,
      error: "No hay cobros registrados para cerrar este pedido.",
      status: 400,
    }
  }

  const metadata = isRecord(latestSale.metadata) ? latestSale.metadata : {}
  const orderTotal = Number(metadata.channel_order_total)
  const paidAccumulated = Number(metadata.channel_paid_accumulated)
  if (
    Number.isFinite(orderTotal) &&
    Number.isFinite(paidAccumulated) &&
    paidAccumulated + 0.009 < orderTotal
  ) {
    return {
      success: false,
      error: "El pedido aún tiene saldo pendiente de cobro.",
      status: 400,
    }
  }

  const patch = { sale_id: String(latestSale.id) }
  const applied = await auditedUpdate(supabase, {
    kind: "mostrador.update",
    table: "counter_orders",
    id: orderId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true, data: {} }
}
