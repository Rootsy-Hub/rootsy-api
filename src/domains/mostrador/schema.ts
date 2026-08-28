import { z } from "@hono/zod-openapi"

export const COUNTER_ORDER_STATUSES = [
  "preparing",
  "dispatched",
  "delivered",
  "cancelled",
] as const

export const COUNTER_FULFILLMENT_TYPES = ["pickup", "delivery"] as const

export const createCounterOrderBodySchema = z
  .object({
    fulfillmentType: z.enum(COUNTER_FULFILLMENT_TYPES),
    deliveryAddress: z.string().optional(),
    phone: z.string().optional(),
    driverName: z.string().optional(),
    estimatedMinutes: z.number().int().min(15).max(60),
    notes: z.string().optional(),
    immediateFulfillment: z.boolean().optional(),
    checkout: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateCounterOrder")

export const patchCounterOrderBodySchema = createCounterOrderBodySchema
  .omit({ checkout: true })
  .partial()
  .openapi("PatchCounterOrder")

export const counterOrderStatusBodySchema = z
  .object({
    status: z.enum(COUNTER_ORDER_STATUSES),
  })
  .openapi("CounterOrderStatusBody")

export const counterOrderCheckoutBodySchema = z
  .object({
    checkout: z.record(z.string(), z.unknown()),
  })
  .openapi("CounterOrderCheckout")

export const closeCounterOrderBodySchema = z
  .object({
    mode: z.enum(["settle", "release"]),
  })
  .openapi("CloseCounterOrder")

export type CreateCounterOrderBody = z.infer<typeof createCounterOrderBodySchema>
export type PatchCounterOrderBody = Partial<CreateCounterOrderBody>
export type CounterOrderStatus = (typeof COUNTER_ORDER_STATUSES)[number]
export type CounterFulfillmentType = (typeof COUNTER_FULFILLMENT_TYPES)[number]

export type CounterOrder = {
  id: string
  orderDay: string
  orderNumber: number
  status: CounterOrderStatus
  fulfillmentType: CounterFulfillmentType
  deliveryAddress: string
  phone: string
  driverName: string
  estimatedMinutes: number
  notes: string
  immediateFulfillment: boolean
  saleId: string | null
  openedAt: string
  updatedAt: string
  deliveredAt: string | null
  checkout: Record<string, unknown> | null
}

export const COUNTER_ORDER_SELECT = `
  id,
  order_day,
  order_number,
  status,
  fulfillment_type,
  delivery_address,
  phone,
  driver_name,
  estimated_minutes,
  notes,
  immediate_fulfillment,
  sale_id,
  opened_at,
  updated_at,
  delivered_at,
  metadata
`
