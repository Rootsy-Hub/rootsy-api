import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { createClient, deleteClient, updateClient } from "./mutations.js"
import { listClients } from "./queries.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  createClientRoute,
  deleteClientRoute,
  listClientsRoute,
  patchClientRoute,
} from "./openapi.js"
import { toListClientsQuery, upsertClientBodySchema } from "./schema.js"

function clientCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`clients:${action}`)
  return {
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

export const clientRoutes = createOpenApiApp<SidecarEnv>()

clientRoutes.openapi(listClientsRoute, async (c) => {
  const result = await listClients(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListClientsQuery(c.req.valid("query")),
    clientCaps(c.get("sidecar")),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

clientRoutes.openapi(createClientRoute, async (c) => {
  const result = await createClient(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.req.valid("json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  if (!result.id) return apiFail(c, "Error interno", 500)
  return c.json({ success: true as const, id: result.id }, 201)
})

clientRoutes.openapi(patchClientRoute, async (c) => {
  const { clientId } = c.req.valid("param")
  const body = parsePatchBody(
    upsertClientBodySchema,
    await c.req.json().catch(() => null),
  )
  if (!body.success) return apiFail(c, body.error, 400)
  const result = await updateClient(
    c.get("supabase"),
    c.get("sidecar").popId,
    clientId,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json({ success: true as const }, 200)
})

clientRoutes.openapi(deleteClientRoute, async (c) => {
  const { clientId } = c.req.valid("param")
  const { confirmationTyped } = c.req.valid("json")
  const result = await deleteClient(
    c.get("supabase"),
    c.get("sidecar").popId,
    clientId,
    confirmationTyped,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json({ success: true as const }, 200)
})
