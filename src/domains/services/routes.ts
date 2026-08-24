import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  SERVICE_CREATE,
  SERVICE_DELETE,
  SERVICE_READ,
  SERVICE_UPDATE,
} from "./allowlist.js"
import { uploadServiceImage } from "./image.js"
import { createService, deleteService, updateService } from "./mutations.js"
import { getService, listServices, searchServiceArticles } from "./queries.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  deleteServiceBodySchema,
  listServiceArticlesQuerySchema,
  listServicesQuerySchema,
  toListServicesQuery,
  upsertServiceBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

function serviceCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`services:${action}`)
  return {
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

export const serviceRoutes = new Hono<SidecarEnv>()

serviceRoutes.get("/", requireAnyPermission(SERVICE_READ), async (c) => {
  const parsed = listServicesQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    soloActivos: c.req.query("soloActivos") || undefined,
    categoryId: c.req.query("categoryId") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listServices(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListServicesQuery(parsed.data),
    serviceCaps(c.get("sidecar")),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

serviceRoutes.post("/", requireMutationPermission(SERVICE_CREATE), async (c) => {
  const body = upsertServiceBodySchema.safeParse(
    await c.req.json().catch(() => null),
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
  const result = await createService(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

serviceRoutes.post(
  "/image",
  requireAnyPermission([...SERVICE_CREATE, ...SERVICE_UPDATE]),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      return c.json({ success: false, error: "Elegí una imagen para subir." }, 400)
    }
    const result = await uploadServiceImage(
      c.get("supabase"),
      c.get("sidecar").popId,
      file,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

serviceRoutes.get(
  "/articles",
  requireAnyPermission(SERVICE_READ),
  async (c) => {
    const parsed = listServiceArticlesQuerySchema.safeParse({
      q: c.req.query("q") || undefined,
      exclude: c.req.query("exclude") || undefined,
      limit: c.req.query("limit") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }

    const exclude = parsed.data.exclude
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)

    const result = await searchServiceArticles(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data.q,
      exclude,
      parsed.data.limit,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

serviceRoutes.get("/:serviceId", requireAnyPermission(SERVICE_READ), async (c) => {
  const id = idSchema.safeParse(c.req.param("serviceId"))
  if (!id.success) {
    return c.json({ success: false, error: "serviceId inválido" }, 400)
  }
  const result = await getService(
    c.get("supabase"),
    c.get("sidecar").popId,
    id.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

serviceRoutes.patch(
  "/:serviceId",
  requireMutationPermission(SERVICE_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("serviceId"))
    if (!id.success) {
      return c.json({ success: false, error: "serviceId inválido" }, 400)
    }
    const body = parsePatchBody(
      upsertServiceBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const result = await updateService(
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

serviceRoutes.delete(
  "/:serviceId",
  requireMutationPermission(SERVICE_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("serviceId"))
    if (!id.success) {
      return c.json({ success: false, error: "serviceId inválido" }, 400)
    }
    const body = deleteServiceBodySchema.safeParse(
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
    const result = await deleteService(
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
