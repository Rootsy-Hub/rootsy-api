import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { COMANDAS_GET, COMANDAS_UPDATE } from "./allowlist.js"
import {
  listStationTicketsQuerySchema,
  pendingQuerySchema,
  sendBodySchema,
  statusBodySchema,
  voidBodySchema,
} from "./schema.js"

const tags = ["Comandas"]
const read = [requireAnyPermission(COMANDAS_GET)] as const
const update = [requireMutationPermission(COMANDAS_UPDATE)] as const

export const listComandaStationsRoute = documentedRoute({
  method: "get",
  path: "/stations",
  tags,
  summary: "Estaciones activas",
  description: "Permiso `comandas:read` (o mesas/mostrador read/update).",
  middleware: read,
})

export const pendingComandasRoute = documentedRoute({
  method: "get",
  path: "/pending",
  tags,
  summary: "Pendientes de un origen",
  description: "Mesa o mostrador. Query `sourceKind` + `sourceId`.",
  middleware: read,
  query: pendingQuerySchema,
})

export const sendComandaRoute = documentedRoute({
  method: "post",
  path: "/send",
  tags,
  summary: "Enviar comanda",
  description: "Permiso `comandas:update` (o mesas/mostrador update).",
  middleware: update,
  body: sendBodySchema,
})

export const voidComandaRoute = documentedRoute({
  method: "post",
  path: "/void",
  tags,
  summary: "Anular líneas de comanda",
  description: "Permiso `comandas:update` (o mesas/mostrador update).",
  middleware: update,
  body: voidBodySchema,
})

export const listStationTicketsRoute = documentedRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Tickets de una estación",
  description: "Query `stationId`.",
  middleware: read,
  query: listStationTicketsQuerySchema,
})

export const getComandaTicketRoute = documentedRoute({
  method: "get",
  path: "/{ticketId}",
  tags,
  summary: "Obtener comanda",
  middleware: read,
})

export const comandaStatusRoute = documentedRoute({
  method: "patch",
  path: "/{ticketId}/status",
  tags,
  summary: "Mover estado de la comanda",
  description: "Permiso `comandas:update` (o mesas/mostrador update).",
  middleware: update,
  body: statusBodySchema,
})
