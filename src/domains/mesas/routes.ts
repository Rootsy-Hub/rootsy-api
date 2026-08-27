import type { Context } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput, routeParam } from "../../openapi/valid.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  checkoutSavedPayload,
  publishMesasEventBestEffort,
  reservationRealtimeSnapshot,
  sessionRealtimeSnapshot,
} from "./realtime.js"
import {
  createDecor,
  createSalon,
  createTable,
  deleteDecor,
  deleteSalon,
  deleteTable,
  reorderDecorsInSalon,
  reorderRows,
  reorderTablesInSalon,
  saveLayoutPositions,
  updateDecor,
  updateSalon,
  updateTable,
} from "./layoutMutations.js"
import {
  getMesasLayout,
  getMesasWaiters,
  getOpenSession,
  getReservationSettings,
  listOpenSessions,
  listReservations,
} from "./queries.js"
import {
  cancelReservation,
  updateReservationSettings,
  updateReservationStatus,
  upsertReservation,
} from "./reservationMutations.js"
import {
  closeSession,
  closeSessionCheckout,
  openSession,
  saveSessionCheckout,
  setSessionFloorStatus,
  updateSession,
} from "./sessionMutations.js"
import {
  cancelReservationRoute,
  closeSessionCheckoutRoute,
  closeSessionRoute,
  createDecorRoute,
  createReservationRoute,
  createSalonRoute,
  createTableRoute,
  deleteDecorRoute,
  deleteSalonRoute,
  deleteTableRoute,
  getReservationSettingsRoute,
  getSessionRoute,
  listReservationsRoute,
  listSessionsRoute,
  mesasLayoutPositionsRoute,
  mesasLayoutRoute,
  mesasWaitersRoute,
  openSessionRoute,
  patchDecorRoute,
  patchReservationRoute,
  patchReservationSettingsRoute,
  patchSalonRoute,
  patchSessionRoute,
  patchTableRoute,
  reorderDecorsRoute,
  reorderSalonsRoute,
  reorderTablesRoute,
  reservationStatusRoute,
  sessionCheckoutRoute,
  sessionFloorStatusRoute,
} from "./openapi.js"
import type { z } from "zod"
import {
  closeSessionCheckoutBodySchema,
  decorBodySchema,
  layoutPositionsBodySchema,
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

export const mesasRoutes = createOpenApiApp<SidecarEnv>()

async function publishLayoutChanged(c: Context<SidecarEnv>) {
  await publishMesasEventBestEffort(c, {
    type: "mesas.layout_changed",
    resourceId: c.get("sidecar").popId,
    payload: {},
  })
}

mesasRoutes.openapi(mesasLayoutRoute, async (c) => {
  const result = await getMesasLayout(c.get("supabase"), c.get("sidecar").popId)
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mesasRoutes.openapi(mesasLayoutPositionsRoute, async (c) => {
  const result = await saveLayoutPositions(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof layoutPositionsBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(mesasWaitersRoute, async (c) => {
  const result = await getMesasWaiters(c.get("supabase"), c.get("sidecar").popId)
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mesasRoutes.openapi(reorderSalonsRoute, async (c) => {
  const result = await reorderRows(
    c.get("supabase"),
    c.get("sidecar").popId,
    "dining_salons",
    routeInput<z.infer<typeof reorderSalonsBodySchema>>(c, "json").updates,
    c.get("mutationAudit"),
    "mesas.salons.reorder",
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(createSalonRoute, async (c) => {
  const result = await createSalon(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof salonBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 201)
})

mesasRoutes.openapi(patchSalonRoute, async (c) => {
  const parsed = parsePatchBody(
    salonBodySchema,
    await c.req.json().catch(() => null),
  )
  if (!parsed.success) return apiFail(c, parsed.error, 400)
  const result = await updateSalon(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "salonId"),
    parsed.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(deleteSalonRoute, async (c) => {
  const result = await deleteSalon(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "salonId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(reorderTablesRoute, async (c) => {
  const body = routeInput<z.infer<typeof reorderSalonItemsBodySchema>>(c, "json")
  const result = await reorderTablesInSalon(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.salonId,
    body.updates,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(createTableRoute, async (c) => {
  const result = await createTable(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof tableBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 201)
})

mesasRoutes.openapi(patchTableRoute, async (c) => {
  const parsed = parsePatchBody(
    tableBodySchema,
    await c.req.json().catch(() => null),
  )
  if (!parsed.success) return apiFail(c, parsed.error, 400)
  const result = await updateTable(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "tableId"),
    parsed.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(deleteTableRoute, async (c) => {
  const result = await deleteTable(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "tableId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(reorderDecorsRoute, async (c) => {
  const body = routeInput<z.infer<typeof reorderSalonItemsBodySchema>>(c, "json")
  const result = await reorderDecorsInSalon(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.salonId,
    body.updates,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(createDecorRoute, async (c) => {
  const result = await createDecor(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof decorBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 201)
})

mesasRoutes.openapi(patchDecorRoute, async (c) => {
  const parsed = parsePatchBody(
    decorBodySchema,
    await c.req.json().catch(() => null),
  )
  if (!parsed.success) return apiFail(c, parsed.error, 400)
  const result = await updateDecor(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "decorId"),
    parsed.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(deleteDecorRoute, async (c) => {
  const result = await deleteDecor(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "decorId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishLayoutChanged(c)
  return c.json(result, 200)
})

mesasRoutes.openapi(listSessionsRoute, async (c) => {
  const result = await listOpenSessions(c.get("supabase"), c.get("sidecar").popId)
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mesasRoutes.openapi(openSessionRoute, async (c) => {
  const result = await openSession(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    routeInput<z.infer<typeof sessionBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.session_opened",
    resourceId: result.session.id,
    resourceType: "session",
    payload: { session: sessionRealtimeSnapshot(result.session) },
  })
  return c.json(result, 201)
})

mesasRoutes.openapi(getSessionRoute, async (c) => {
  const result = await getOpenSession(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "sessionId"),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mesasRoutes.openapi(patchSessionRoute, async (c) => {
  const result = await updateSession(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "sessionId"),
    routeInput<z.infer<typeof sessionBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.session_updated",
    resourceId: result.session.id,
    resourceType: "session",
    payload: { session: sessionRealtimeSnapshot(result.session) },
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(closeSessionRoute, async (c) => {
  const result = await closeSession(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "sessionId"),
    c.get("userId"),
    "cancelled",
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.session_closed",
    resourceId: routeParam(c, "sessionId"),
    resourceType: "session",
    payload: { sessionId: routeParam(c, "sessionId") },
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(closeSessionCheckoutRoute, async (c) => {
  routeInput<z.infer<typeof closeSessionCheckoutBodySchema>>(c, "json")
  const result = await closeSessionCheckout(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "sessionId"),
    c.get("userId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.session_closed",
    resourceId: routeParam(c, "sessionId"),
    resourceType: "session",
    payload: { sessionId: routeParam(c, "sessionId") },
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(sessionCheckoutRoute, async (c) => {
  const checkout = routeInput<z.infer<typeof sessionCheckoutBodySchema>>(c, "json")
    .checkout
  const sessionId = routeParam(c, "sessionId")
  const result = await saveSessionCheckout(
    c.get("supabase"),
    c.get("sidecar").popId,
    sessionId,
    checkout,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.checkout_saved",
    resourceId: sessionId,
    resourceType: "session",
    payload: checkoutSavedPayload(sessionId, result.updatedAt, checkout),
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(sessionFloorStatusRoute, async (c) => {
  const result = await setSessionFloorStatus(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "sessionId"),
    routeInput<z.infer<typeof sessionFloorStatusBodySchema>>(c, "json")
      .floorStatus,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.floor_status_changed",
    resourceId: routeParam(c, "sessionId"),
    resourceType: "session",
    payload: {
      sessionId: routeParam(c, "sessionId"),
      floorStatus: result.floorStatus,
      updatedAt: result.updatedAt,
    },
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(getReservationSettingsRoute, async (c) => {
  const result = await getReservationSettings(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mesasRoutes.openapi(patchReservationSettingsRoute, async (c) => {
  const result = await updateReservationSettings(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof reservationSettingsBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.settings_updated",
    resourceId: c.get("sidecar").popId,
    payload: {},
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(listReservationsRoute, async (c) => {
  const result = await listReservations(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

mesasRoutes.openapi(createReservationRoute, async (c) => {
  const result = await upsertReservation(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof reservationBodySchema>>(c, "json"),
    null,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.reservation_upserted",
    resourceId: result.reservation.id,
    resourceType: "reservation",
    payload: { reservation: reservationRealtimeSnapshot(result.reservation) },
  })
  return c.json(result, 201)
})

mesasRoutes.openapi(patchReservationRoute, async (c) => {
  const result = await upsertReservation(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeInput<z.infer<typeof reservationBodySchema>>(c, "json"),
    routeParam(c, "reservationId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.reservation_upserted",
    resourceId: result.reservation.id,
    resourceType: "reservation",
    payload: { reservation: reservationRealtimeSnapshot(result.reservation) },
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(cancelReservationRoute, async (c) => {
  const result = await cancelReservation(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "reservationId"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.reservation_cancelled",
    resourceId: routeParam(c, "reservationId"),
    resourceType: "reservation",
    payload: { reservationId: routeParam(c, "reservationId") },
  })
  return c.json(result, 200)
})

mesasRoutes.openapi(reservationStatusRoute, async (c) => {
  const result = await updateReservationStatus(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "reservationId"),
    routeInput<z.infer<typeof reservationStatusBodySchema>>(c, "json").status,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishMesasEventBestEffort(c, {
    type: "mesas.reservation_status_changed",
    resourceId: result.reservation.id,
    resourceType: "reservation",
    payload: { reservation: reservationRealtimeSnapshot(result.reservation) },
  })
  return c.json(result, 200)
})
