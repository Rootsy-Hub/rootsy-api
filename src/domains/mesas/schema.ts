import { z } from "@hono/zod-openapi"

export const MESA_FLOOR_DECOR_KINDS = [
  "wall_h",
  "wall_v",
  "pillar",
  "entrance",
  "window",
  "bar",
  "register",
  "restroom",
  "kitchen",
  "stairs",
  "plant",
  "planter",
  "label",
  "zone",
] as const

export const TABLE_SHAPE_KIND = ["round", "square", "rect"] as const
export const ROUND_SIZES = ["s", "m", "l", "xl"] as const
export const SQUARE_SIZES = ["s", "m", "l"] as const
export const RECT_SIZES = ["s", "m", "l", "xl"] as const

export const tableShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("round"), size: z.enum(ROUND_SIZES) }),
  z.object({ kind: z.literal("square"), size: z.enum(SQUARE_SIZES) }),
  z.object({ kind: z.literal("rect"), size: z.enum(RECT_SIZES) }),
])

export const salonBodySchema = z
  .object({
    name: z.string(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
  })
  .openapi("SalonBody")

export const tableBodySchema = z
  .object({
    salonId: z.string().uuid(),
    label: z.string(),
    shape: tableShapeSchema,
    x: z.number(),
    y: z.number(),
    seats: z.number(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
  })
  .openapi("TableBody")

export const decorBodySchema = z
  .object({
    salonId: z.string().uuid(),
    kind: z.enum(MESA_FLOOR_DECOR_KINDS),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    label: z.string(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
  })
  .openapi("DecorBody")

export const sortOrderUpdateSchema = z.object({
  id: z.string().uuid(),
  sortOrder: z.number().int(),
})

export const reorderSalonsBodySchema = z
  .object({
    updates: z.array(sortOrderUpdateSchema),
  })
  .openapi("ReorderSalons")

export const reorderSalonItemsBodySchema = z
  .object({
    salonId: z.string().uuid(),
    updates: z.array(sortOrderUpdateSchema),
  })
  .openapi("ReorderSalonItems")

const layoutPositionSchema = z.object({
  id: z.string().uuid(),
  x: z.number(),
  y: z.number(),
  rotation: z.number().optional(),
})

export const layoutPositionsBodySchema = z
  .object({
    tables: z.array(layoutPositionSchema).optional(),
    decors: z.array(layoutPositionSchema).optional(),
  })
  .openapi("LayoutPositions")

export const sessionBodySchema = z
  .object({
    tableIds: z.array(z.string().uuid()).min(1),
    waiterId: z.string().optional(),
    guestCount: z.number().nullable().optional(),
    note: z.string().optional(),
    reservationId: z.string().uuid().nullable().optional(),
    checkout: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SessionBody")

export const sessionFloorStatusBodySchema = z
  .object({
    floorStatus: z.enum(["open", "paying"]),
  })
  .openapi("SessionFloorStatus")

export const sessionCheckoutBodySchema = z
  .object({
    checkout: z.record(z.string(), z.unknown()),
  })
  .openapi("SessionCheckout")

export const closeSessionCheckoutBodySchema = z
  .object({
    mode: z.enum(["settle", "release"]),
  })
  .openapi("CloseSessionCheckout")

export const RESERVATION_STATUSES = [
  "pending",
  "confirmed",
  "seated",
  "completed",
  "expired",
  "no_show",
  "cancelled",
] as const

export const reservationBodySchema = z
  .object({
    tableId: z.string().uuid().nullable().optional(),
    tableIds: z.array(z.string().uuid()).optional(),
    clientId: z.string().uuid().nullable(),
    clientName: z.string(),
    guestCount: z.number().nullable().optional(),
    arrivalAt: z.string(),
    status: z.enum(RESERVATION_STATUSES).optional(),
    note: z.string().optional(),
  })
  .openapi("ReservationBody")

export const reservationStatusBodySchema = z
  .object({
    status: z.enum(RESERVATION_STATUSES),
  })
  .openapi("ReservationStatusBody")

export const reservationSettingsBodySchema = z
  .object({
    floorBufferMinutes: z.number(),
    graceMinutes: z.number(),
  })
  .openapi("ReservationSettings")

export const patchSalonBodySchema = salonBodySchema
  .partial()
  .openapi("PatchSalon")
export const patchTableBodySchema = tableBodySchema
  .partial()
  .openapi("PatchTable")
export const patchDecorBodySchema = decorBodySchema
  .partial()
  .openapi("PatchDecor")

export type SalonBody = z.infer<typeof salonBodySchema>
export type TableBody = z.infer<typeof tableBodySchema>
export type DecorBody = z.infer<typeof decorBodySchema>
export type SessionBody = z.infer<typeof sessionBodySchema>
export type ReservationBody = z.infer<typeof reservationBodySchema>
export type TableShape = z.infer<typeof tableShapeSchema>
export type DecorKind = (typeof MESA_FLOOR_DECOR_KINDS)[number]
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]
export type FloorStatus = "open" | "paying"

export type MesasSalon = {
  id: string
  name: string
  sortOrder: number
  isActive: boolean
}

export type MesasTable = {
  id: string
  salonId: string
  label: string
  shape: TableShape
  x: number
  y: number
  rotation: number
  seats: number
  sortOrder: number
  isActive: boolean
}

export type MesasDecor = {
  id: string
  salonId: string
  kind: DecorKind
  x: number
  y: number
  width: number
  height: number
  rotation: number
  label: string
  sortOrder: number
  isActive: boolean
}

export type MesaSession = {
  id: string
  tableIds: string[]
  waiterId: string
  guestCount: number | null
  note: string
  openedAt: string
  updatedAt: string
  checkout: Record<string, unknown> | null
  floorStatus: FloorStatus
}

export type MesaReservation = {
  id: string
  tableId: string | null
  tableIds: string[]
  clientId: string | null
  clientName: string
  guestCount: number | null
  arrivalAt: string
  status: ReservationStatus
  note: string
  updatedAt: string
}

export type MesasWaiter = {
  id: string
  name: string
  initials: string
}

export const TABLE_SELECT =
  "id, salon_id, label, name, pos_x, pos_y, rotation_deg, shape, capacity, sort_order, is_active"

export const DECOR_SELECT =
  "id, salon_id, kind, pos_x, pos_y, rotation_deg, width, height, label, sort_order, is_active"

export const SESSION_SELECT = `
  id,
  dining_table_id,
  waiter_user_id,
  guest_count,
  notes,
  status,
  opened_at,
  updated_at,
  metadata,
  table_session_tables ( dining_table_id )
`

export const RESERVATION_SELECT = `
  id,
  dining_table_id,
  client_id,
  client_name,
  guest_count,
  arrival_at,
  status,
  notes,
  updated_at,
  table_reservation_tables ( dining_table_id )
`
