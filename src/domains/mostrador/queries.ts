import type { SupabaseClient } from "@supabase/supabase-js"
import {
  COUNTER_ORDER_SELECT,
  type CounterFulfillmentType,
  type CounterOrder,
  type CounterOrderStatus,
} from "./schema.js"

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v != null && !Array.isArray(v)
}

export function checkoutFromMetadata(
  metadata: unknown,
): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null
  return isRecord(metadata.checkout) ? metadata.checkout : null
}

export function mapCounterOrderRow(
  row: {
    id: string
    order_day: string
    order_number: number
    status: string
    fulfillment_type: string
    delivery_address: string | null
    phone: string | null
    driver_name: string | null
    estimated_minutes: number
    notes: string | null
    immediate_fulfillment: boolean | null
    sale_id: string | null
    opened_at: string
    updated_at: string
    delivered_at: string | null
    metadata: unknown
  },
  options?: { includeCheckout?: boolean },
): CounterOrder {
  return {
    id: row.id,
    orderDay: row.order_day,
    orderNumber: Number(row.order_number) || 0,
    status: row.status as CounterOrderStatus,
    fulfillmentType: row.fulfillment_type as CounterFulfillmentType,
    deliveryAddress: row.delivery_address?.trim() ?? "",
    phone: row.phone?.trim() ?? "",
    driverName: row.driver_name?.trim() ?? "",
    estimatedMinutes: Number(row.estimated_minutes) || 0,
    notes: row.notes?.trim() ?? "",
    immediateFulfillment: Boolean(row.immediate_fulfillment),
    saleId: row.sale_id,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    checkout:
      options?.includeCheckout === false
        ? null
        : checkoutFromMetadata(row.metadata),
  }
}

export function openBoardQuery(supabase: SupabaseClient, popId: string) {
  return supabase
    .from("counter_orders")
    .select(COUNTER_ORDER_SELECT)
    .eq("pop_id", popId)
    .neq("status", "cancelled")
    .in("status", ["preparing", "dispatched", "delivered"])
    .is("sale_id", null)
}

export async function listCounterOrders(
  supabase: SupabaseClient,
  popId: string,
): Promise<
  | { success: true; data: { orders: CounterOrder[] } }
  | { success: false; error: string }
> {
  const { data, error } = await openBoardQuery(supabase, popId).order(
    "opened_at",
    { ascending: false },
  )
  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: {
      orders: (data ?? []).map((row) =>
        mapCounterOrderRow(row as Parameters<typeof mapCounterOrderRow>[0], {
          includeCheckout: false,
        }),
      ),
    },
  }
}

export async function getCounterOrder(
  supabase: SupabaseClient,
  popId: string,
  orderId: string,
): Promise<
  | { success: true; data: { order: CounterOrder | null } }
  | { success: false; error: string }
> {
  const { data, error } = await openBoardQuery(supabase, popId)
    .eq("id", orderId)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: true, data: { order: null } }
  return {
    success: true,
    data: {
      order: mapCounterOrderRow(data as Parameters<typeof mapCounterOrderRow>[0]),
    },
  }
}

export function validateCreateInput(input: {
  fulfillmentType: CounterFulfillmentType
  deliveryAddress?: string
  phone?: string
  estimatedMinutes: number
}): string | null {
  if (input.estimatedMinutes < 15 || input.estimatedMinutes > 60) {
    return "Tiempo estimado inválido."
  }
  if (input.fulfillmentType === "delivery") {
    if (!input.deliveryAddress?.trim()) {
      return "La dirección es obligatoria para delivery."
    }
    if (!input.phone?.trim()) {
      return "El celular es obligatorio para delivery."
    }
  }
  return null
}

export async function nextOrderNumber(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data } = await supabase
    .from("counter_orders")
    .select("order_number")
    .eq("pop_id", popId)
    .order("order_number", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (Number(data?.order_number) || 0) + 1
}
