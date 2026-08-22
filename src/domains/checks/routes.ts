import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { CHECK_CREATE, CHECK_READ, CHECK_UPDATE } from "./allowlist.js"
import {
  clearCheck,
  createCheck,
  depositCheck,
  rejectCheck,
  voidCheck,
} from "./mutations.js"
import {
  listCheckDepositAccounts,
  listChecks,
  searchCheckParties,
} from "./queries.js"
import {
  clearCheckBodySchema,
  createCheckBodySchema,
  depositCheckBodySchema,
  listChecksQuerySchema,
  rejectCheckBodySchema,
  searchCheckPartiesQuerySchema,
  toListChecksQuery,
} from "./schema.js"

const idSchema = z.string().uuid()

export const checkRoutes = new Hono<SidecarEnv>()

checkRoutes.get("/", requireAnyPermission(CHECK_READ), async (c) => {
  const parsed = listChecksQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    direction: c.req.query("direction") || undefined,
    status: c.req.query("status") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listChecks(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListChecksQuery(parsed.data),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

checkRoutes.get(
  "/deposit-accounts",
  requireAnyPermission(CHECK_UPDATE),
  async (c) => {
    const result = await listCheckDepositAccounts(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

checkRoutes.get("/parties", requireAnyPermission(CHECK_CREATE), async (c) => {
  const parsed = searchCheckPartiesQuerySchema.safeParse({
    q: c.req.query("q") || undefined,
    direction: c.req.query("direction") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const result = await searchCheckParties(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.data.direction,
    parsed.data.q,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

checkRoutes.post("/", requireAnyPermission(CHECK_CREATE), async (c) => {
  const body = createCheckBodySchema.safeParse(
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
  const result = await createCheck(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

checkRoutes.post(
  "/:checkId/deposit",
  requireAnyPermission(CHECK_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("checkId"))
    if (!id.success) {
      return c.json({ success: false, error: "checkId inválido" }, 400)
    }
    const body = depositCheckBodySchema.safeParse(
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
    const result = await depositCheck(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

checkRoutes.post(
  "/:checkId/clear",
  requireAnyPermission(CHECK_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("checkId"))
    if (!id.success) {
      return c.json({ success: false, error: "checkId inválido" }, 400)
    }
    const body = clearCheckBodySchema.safeParse(
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
    const result = await clearCheck(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

checkRoutes.post(
  "/:checkId/reject",
  requireAnyPermission(CHECK_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("checkId"))
    if (!id.success) {
      return c.json({ success: false, error: "checkId inválido" }, 400)
    }
    const body = rejectCheckBodySchema.safeParse(
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
    const result = await rejectCheck(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

checkRoutes.post(
  "/:checkId/void",
  requireAnyPermission(CHECK_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("checkId"))
    if (!id.success) {
      return c.json({ success: false, error: "checkId inválido" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await voidCheck(
      c.get("supabase"),
      sidecar.popId,
      c.get("userId"),
      sidecar.popSiteId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
