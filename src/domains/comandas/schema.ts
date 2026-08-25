import { z } from "@hono/zod-openapi"

export const COMANDA_STATUSES = [
  "pending",
  "sent",
  "preparing",
  "ready",
  "delivered",
  "voided",
] as const

export const COMANDA_BOARD_STATUSES = [
  "sent",
  "preparing",
  "ready",
  "delivered",
] as const

export const COMANDA_SOURCE_KINDS = ["table", "counter"] as const
export const COMANDA_SEND_KINDS = ["order", "void"] as const

export const statusBodySchema = z
  .object({
    status: z.enum(COMANDA_BOARD_STATUSES),
  })
  .openapi("ComandaStatusBody")

export const sendBodySchema = z
  .object({
    sourceKind: z.enum(COMANDA_SOURCE_KINDS),
    sourceId: z.string().uuid(),
    quantities: z.record(z.string(), z.number()),
    stationComments: z.record(z.string(), z.string()),
  })
  .openapi("ComandaSend")

export const voidBodySchema = z
  .object({
    sourceKind: z.enum(COMANDA_SOURCE_KINDS),
    sourceId: z.string().uuid(),
    parentCartLineId: z.string().min(1),
    parentVoidQuantity: z.number(),
    parentRemainderQuantity: z.number(),
    quantities: z.record(z.string(), z.number()),
    comment: z.string(),
  })
  .openapi("ComandaVoid")

export const pendingQuerySchema = z
  .object({
    sourceKind: z.enum(COMANDA_SOURCE_KINDS),
    sourceId: z.string().uuid(),
  })
  .openapi("ComandaPendingQuery")

export const listStationTicketsQuerySchema = z
  .object({
    stationId: z.string().uuid(),
  })
  .openapi("ComandaStationTicketsQuery")

export type ComandaStatus = (typeof COMANDA_STATUSES)[number]
export type ComandaSendKind = (typeof COMANDA_SEND_KINDS)[number]
export type ComandaSourceKind = (typeof COMANDA_SOURCE_KINDS)[number]

export type ComandaTicket = {
  id: string
  stationId: string
  status: ComandaStatus
  sourceKind: ComandaSourceKind
  sourceId: string
  cartLineId: string
  recipeId: string | null
  recipeName: string
  quantity: number
  comment: string
  originLabel: string
  customerName: string
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  sentAt: string | null
  preparingAt: string | null
  readyAt: string | null
  deliveredAt: string | null
  sendId: string | null
  sendKind: ComandaSendKind
  sendComment: string
}

export type ComandaStation = {
  id: string
  name: string
  sortOrder: number
  isActive: boolean
}

export type PendingComandaItem = {
  id: string
  cartLineId: string
  recipeName: string
  quantity: number
  comment: string
  stationId: string
  stationName: string
}

export type ComandaSendPeel = {
  fromCartLineId: string
  sentCartLineId: string
  sentQuantity: number
  remainderQuantity: number
}

export type ComandaVoidPeel = {
  fromCartLineId: string
  voidedCartLineId: string
  voidedQuantity: number
  remainderQuantity: number
}

export const COMANDA_SELECT = `
  id,
  station_id,
  status,
  source_kind,
  source_id,
  cart_line_id,
  recipe_id,
  recipe_name,
  quantity,
  comment,
  origin_label,
  customer_name,
  created_at,
  updated_at,
  status_changed_at,
  sent_at,
  preparing_at,
  ready_at,
  delivered_at,
  send_id,
  comanda_sends ( comment, kind )
`

export const DELIVERED_RETENTION_HOURS = 12
