import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { QUOTE_CREATE, QUOTE_DELETE, QUOTE_READ } from "./allowlist.js"
import { createQuote, deleteQuote } from "./mutations.js"
import { getQuote, listQuotes } from "./queries.js"
import {
  createQuoteBodySchema,
  listQuotesQuerySchema,
  toListQuotesQuery,
} from "./schema.js"

const idSchema = z.string().uuid()

export const quoteRoutes = new Hono<SidecarEnv>()

quoteRoutes.get("/", requireAnyPermission(QUOTE_READ), async (c) => {
  const parsed = listQuotesQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    dateFrom: c.req.query("dateFrom") || undefined,
    dateTo: c.req.query("dateTo") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const sidecar = c.get("sidecar")
  const result = await listQuotes(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    toListQuotesQuery(parsed.data),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

quoteRoutes.post("/", requireMutationPermission(QUOTE_CREATE), async (c) => {
  const body = createQuoteBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await createQuote(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

quoteRoutes.get("/:quoteId", requireAnyPermission(QUOTE_READ), async (c) => {
  const id = idSchema.safeParse(c.req.param("quoteId"))
  if (!id.success) {
    return c.json({ success: false, error: "quoteId inválido" }, 400)
  }
  const result = await getQuote(
    c.get("supabase"),
    c.get("sidecar").popId,
    id.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

quoteRoutes.delete(
  "/:quoteId",
  requireMutationPermission(QUOTE_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("quoteId"))
    if (!id.success) {
      return c.json({ success: false, error: "quoteId inválido" }, 400)
    }
    const result = await deleteQuote(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
