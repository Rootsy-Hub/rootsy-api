import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  CLIENT_CREATE,
  CLIENT_DELETE,
  CLIENT_READ,
  CLIENT_UPDATE,
} from "./allowlist.js"
import { createClient, deleteClient, updateClient } from "./mutations.js"
import { listClients } from "./queries.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  deleteClientBodySchema,
  listClientsQuerySchema,
  toListClientsQuery,
  upsertClientBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

function clientCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`clients:${action}`)
  return {
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

export const clientRoutes = new Hono<SidecarEnv>()

clientRoutes.get("/", requireAnyPermission(CLIENT_READ), async (c) => {
  const parsed = listClientsQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    soloActivos: c.req.query("soloActivos") || undefined,
    withEmail: c.req.query("withEmail") || undefined,
    withTaxId: c.req.query("withTaxId") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listClients(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListClientsQuery(parsed.data),
    clientCaps(c.get("sidecar")),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

clientRoutes.post("/", requireMutationPermission(CLIENT_CREATE), async (c) => {
  const body = upsertClientBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await createClient(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

clientRoutes.patch(
  "/:clientId",
  requireMutationPermission(CLIENT_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("clientId"))
    if (!id.success) {
      return c.json({ success: false, error: "clientId inválido" }, 400)
    }
    const body = parsePatchBody(
      upsertClientBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const result = await updateClient(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

clientRoutes.delete(
  "/:clientId",
  requireMutationPermission(CLIENT_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("clientId"))
    if (!id.success) {
      return c.json({ success: false, error: "clientId inválido" }, 400)
    }
    const body = deleteClientBodySchema.safeParse(
      await c.req.json().catch(() => ({ confirmationTyped: "" })),
    )
    if (!body.success) {
      return c.json(
        {
          success: false,
          error: body.error.issues[0]?.message ?? "Body inválido",
        },
        400,
      )
    }
    const result = await deleteClient(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data.confirmationTyped,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
