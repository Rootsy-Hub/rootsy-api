import type { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput, routeParam } from "../../openapi/valid.js"
import {
  moveComandaStatus,
  sendComandaBatch,
  voidComandaBatch,
} from "./mutations.js"
import {
  getComandaTicket,
  listActiveStations,
  listPendingForSource,
  listStationTickets,
  listTicketsByCartLineIds,
} from "./queries.js"
import {
  publishComandasEventBestEffort,
  ticketRealtimeSnapshot,
  ticketsPayload,
} from "./realtime.js"
import {
  comandaStatusRoute,
  getComandaTicketRoute,
  listComandaStationsRoute,
  listStationTicketsRoute,
  pendingComandasRoute,
  sendComandaRoute,
  voidComandaRoute,
} from "./openapi.js"
import {
  listStationTicketsQuerySchema,
  pendingQuerySchema,
  sendBodySchema,
  statusBodySchema,
  voidBodySchema,
} from "./schema.js"

export const comandasRoutes = createOpenApiApp<SidecarEnv>()

comandasRoutes.openapi(listComandaStationsRoute, async (c) => {
  const result = await listActiveStations(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

comandasRoutes.openapi(pendingComandasRoute, async (c) => {
  const parsed = routeInput<z.infer<typeof pendingQuerySchema>>(c, "query")
  const result = await listPendingForSource(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.sourceKind,
    parsed.sourceId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

comandasRoutes.openapi(sendComandaRoute, async (c) => {
  const body = routeInput<z.infer<typeof sendBodySchema>>(c, "json")
  const result = await sendComandaBatch(
    c.get("supabase"),
    c.get("sidecar").popId,
    body,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  const sentTickets = await listTicketsByCartLineIds(
    c.get("supabase"),
    c.get("sidecar").popId,
    result.sentCartLineIds,
  )
  await publishComandasEventBestEffort(c, {
    type: "comandas.sent",
    resourceId: body.sourceId,
    payload: {
      sourceKind: body.sourceKind,
      sourceId: body.sourceId,
      sentCartLineIds: result.sentCartLineIds,
      peels: result.peels,
      tickets: ticketsPayload(sentTickets),
    },
  })
  return c.json(result, 201)
})

comandasRoutes.openapi(voidComandaRoute, async (c) => {
  const body = routeInput<z.infer<typeof voidBodySchema>>(c, "json")
  const result = await voidComandaBatch(
    c.get("supabase"),
    c.get("sidecar").popId,
    body,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  const voidedTickets = await listTicketsByCartLineIds(
    c.get("supabase"),
    c.get("sidecar").popId,
    [...result.voidedCartLineIds, ...result.peels.map((peel) => peel.voidedCartLineId)],
  )
  await publishComandasEventBestEffort(c, {
    type: "comandas.voided",
    resourceId: body.sourceId,
    payload: {
      sourceKind: body.sourceKind,
      sourceId: body.sourceId,
      voidedCartLineIds: result.voidedCartLineIds,
      peels: result.peels,
      tickets: ticketsPayload(voidedTickets),
    },
  })
  return c.json(result, 201)
})

comandasRoutes.openapi(listStationTicketsRoute, async (c) => {
  const result = await listStationTickets(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof listStationTicketsQuerySchema>>(c, "query")
      .stationId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

comandasRoutes.openapi(getComandaTicketRoute, async (c) => {
  const result = await getComandaTicket(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "ticketId"),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

comandasRoutes.openapi(comandaStatusRoute, async (c) => {
  const result = await moveComandaStatus(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "ticketId"),
    routeInput<z.infer<typeof statusBodySchema>>(c, "json").status,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishComandasEventBestEffort(c, {
    type: "comandas.status_changed",
    resourceId: result.ticket.id,
    payload: {
      ticketId: result.ticket.id,
      status: result.ticket.status,
      sourceKind: result.ticket.sourceKind,
      sourceId: result.ticket.sourceId,
      cartLineId: result.ticket.cartLineId,
      ticket: ticketRealtimeSnapshot(result.ticket),
    },
  })
  return c.json(result, 200)
})
