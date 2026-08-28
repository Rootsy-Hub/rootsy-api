import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { MESAS_CREATE, MESAS_READ, MESAS_UPDATE } from "./allowlist.js"
import {
  closeSessionCheckoutBodySchema,
  decorBodySchema,
  layoutPositionsBodySchema,
  patchDecorBodySchema,
  patchSalonBodySchema,
  patchTableBodySchema,
  reorderSalonItemsBodySchema,
  reorderSalonsBodySchema,
  reservationBodySchema,
  reservationSettingsBodySchema,
  reservationStatusBodySchema,
  salonBodySchema,
  sessionBodySchema,
  sessionCheckoutBodySchema,
  sessionFloorStatusBodySchema,
  tableBodySchema,
} from "./schema.js"

const tags = ["Mesas"]
const read = [requireAnyPermission(MESAS_READ)] as const
const create = [requireMutationPermission(MESAS_CREATE)] as const
const update = [requireMutationPermission(MESAS_UPDATE)] as const

export const mesasLayoutRoute = documentedRoute({
  method: "get",
  path: "/layout",
  tags,
  summary: "Layout del salón",
  description: "Salones, mesas y decors. Permiso `mesas:read`.",
  middleware: read,
})

export const mesasLayoutPositionsRoute = documentedRoute({
  method: "patch",
  path: "/layout/positions",
  tags,
  summary: "Guardar posiciones",
  description: "Permiso `mesas:update` (o aprobación).",
  middleware: update,
  body: layoutPositionsBodySchema,
})

export const mesasWaitersRoute = documentedRoute({
  method: "get",
  path: "/waiters",
  tags,
  summary: "Mozos del local",
  middleware: read,
})

export const reorderSalonsRoute = documentedRoute({
  method: "patch",
  path: "/salons/reorder",
  tags,
  summary: "Reordenar salones",
  middleware: update,
  body: reorderSalonsBodySchema,
})

export const createSalonRoute = documentedRoute({
  method: "post",
  path: "/salons",
  tags,
  summary: "Crear salón",
  middleware: update,
  body: salonBodySchema,
})

export const patchSalonRoute = documentedRoute({
  method: "patch",
  path: "/salons/{salonId}",
  tags,
  summary: "Actualizar salón",
  description: "PATCH parcial.",
  middleware: update,
  body: patchSalonBodySchema,
})

export const deleteSalonRoute = documentedRoute({
  method: "delete",
  path: "/salons/{salonId}",
  tags,
  summary: "Eliminar salón",
  middleware: update,
})

export const reorderTablesRoute = documentedRoute({
  method: "patch",
  path: "/tables/reorder",
  tags,
  summary: "Reordenar mesas",
  middleware: update,
  body: reorderSalonItemsBodySchema,
})

export const createTableRoute = documentedRoute({
  method: "post",
  path: "/tables",
  tags,
  summary: "Crear mesa",
  middleware: update,
  body: tableBodySchema,
})

export const patchTableRoute = documentedRoute({
  method: "patch",
  path: "/tables/{tableId}",
  tags,
  summary: "Actualizar mesa",
  description: "PATCH parcial.",
  middleware: update,
  body: patchTableBodySchema,
})

export const deleteTableRoute = documentedRoute({
  method: "delete",
  path: "/tables/{tableId}",
  tags,
  summary: "Eliminar mesa",
  middleware: update,
})

export const reorderDecorsRoute = documentedRoute({
  method: "patch",
  path: "/decors/reorder",
  tags,
  summary: "Reordenar decors",
  middleware: update,
  body: reorderSalonItemsBodySchema,
})

export const createDecorRoute = documentedRoute({
  method: "post",
  path: "/decors",
  tags,
  summary: "Crear decor",
  middleware: update,
  body: decorBodySchema,
})

export const patchDecorRoute = documentedRoute({
  method: "patch",
  path: "/decors/{decorId}",
  tags,
  summary: "Actualizar decor",
  description: "PATCH parcial.",
  middleware: update,
  body: patchDecorBodySchema,
})

export const deleteDecorRoute = documentedRoute({
  method: "delete",
  path: "/decors/{decorId}",
  tags,
  summary: "Eliminar decor",
  middleware: update,
})

export const listSessionsRoute = documentedRoute({
  method: "get",
  path: "/sessions",
  tags,
  summary: "Sesiones abiertas",
  description:
    "Piso: ocupación sin ticket. El checkout va en GET /sessions/{sessionId}.",
  middleware: read,
})

export const openSessionRoute = documentedRoute({
  method: "post",
  path: "/sessions",
  tags,
  summary: "Abrir mesa",
  description: "Permiso `mesas:create` (o aprobación).",
  middleware: create,
  body: sessionBodySchema,
})

export const getSessionRoute = documentedRoute({
  method: "get",
  path: "/sessions/{sessionId}",
  tags,
  summary: "Obtener sesión",
  middleware: read,
})

export const patchSessionRoute = documentedRoute({
  method: "patch",
  path: "/sessions/{sessionId}",
  tags,
  summary: "Actualizar sesión",
  middleware: update,
  body: sessionBodySchema,
})

export const closeSessionRoute = documentedRoute({
  method: "patch",
  path: "/sessions/{sessionId}/close",
  tags,
  summary: "Cerrar sesión",
  middleware: update,
})

export const closeSessionCheckoutRoute = documentedRoute({
  method: "patch",
  path: "/sessions/{sessionId}/close-checkout",
  tags,
  summary: "Cerrar con checkout",
  description: "`settle` o `release`.",
  middleware: update,
  body: closeSessionCheckoutBodySchema,
})

export const sessionCheckoutRoute = documentedRoute({
  method: "patch",
  path: "/sessions/{sessionId}/checkout",
  tags,
  summary: "Guardar checkout de mesa",
  middleware: update,
  body: sessionCheckoutBodySchema,
})

export const sessionFloorStatusRoute = documentedRoute({
  method: "patch",
  path: "/sessions/{sessionId}/floor-status",
  tags,
  summary: "Estado en salón",
  description: "`open` o `paying`.",
  middleware: update,
  body: sessionFloorStatusBodySchema,
})

export const getReservationSettingsRoute = documentedRoute({
  method: "get",
  path: "/reservation-settings",
  tags,
  summary: "Ajustes de reservas",
  middleware: read,
})

export const patchReservationSettingsRoute = documentedRoute({
  method: "patch",
  path: "/reservation-settings",
  tags,
  summary: "Actualizar ajustes de reservas",
  middleware: update,
  body: reservationSettingsBodySchema,
})

export const listReservationsRoute = documentedRoute({
  method: "get",
  path: "/reservations",
  tags,
  summary: "Listar reservas",
  middleware: read,
})

export const createReservationRoute = documentedRoute({
  method: "post",
  path: "/reservations",
  tags,
  summary: "Crear reserva",
  middleware: update,
  body: reservationBodySchema,
})

export const patchReservationRoute = documentedRoute({
  method: "patch",
  path: "/reservations/{reservationId}",
  tags,
  summary: "Actualizar reserva",
  middleware: update,
  body: reservationBodySchema,
})

export const cancelReservationRoute = documentedRoute({
  method: "patch",
  path: "/reservations/{reservationId}/cancel",
  tags,
  summary: "Cancelar reserva",
  middleware: update,
})

export const reservationStatusRoute = documentedRoute({
  method: "patch",
  path: "/reservations/{reservationId}/status",
  tags,
  summary: "Cambiar estado de reserva",
  middleware: update,
  body: reservationStatusBodySchema,
})
