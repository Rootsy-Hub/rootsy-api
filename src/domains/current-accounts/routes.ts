import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { CURRENT_ACCOUNT_CREATE, CURRENT_ACCOUNT_READ } from "./allowlist.js"
import { applyCurrentAccountCredit, setCurrentAccountEnrollment } from "./mutations.js"
import { loadCurrentAccountPaymentContext } from "./paymentContext.js"
import {
  getCurrentAccountLedger,
  listCurrentAccountParties,
  searchEnrollmentCandidates,
} from "./queries.js"
import {
  applyCreditBodySchema,
  enrollmentBodySchema,
  listCurrentAccountsQuerySchema,
  searchCandidatesQuerySchema,
  settleBodySchema,
  toListCurrentAccountsQuery,
} from "./schema.js"
import { settleCurrentAccount } from "./settle.js"

const idSchema = z.string().uuid()

export const currentAccountRoutes = new Hono<SidecarEnv>()

currentAccountRoutes.get("/", requireAnyPermission(CURRENT_ACCOUNT_READ), async (c) => {
  const parsed = listCurrentAccountsQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    direction: c.req.query("direction") || undefined,
    aging: c.req.query("aging") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const sidecar = c.get("sidecar")
  const result = await listCurrentAccountParties(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    toListCurrentAccountsQuery(parsed.data),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

currentAccountRoutes.get(
  "/candidates",
  requireAnyPermission(CURRENT_ACCOUNT_CREATE),
  async (c) => {
    const parsed = searchCandidatesQuerySchema.safeParse({
      q: c.req.query("q") || undefined,
      direction: c.req.query("direction") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await searchEnrollmentCandidates(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data.direction,
      parsed.data.q,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

currentAccountRoutes.get(
  "/payment-context",
  requireAnyPermission(CURRENT_ACCOUNT_CREATE),
  async (c) => {
    const result = await loadCurrentAccountPaymentContext(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

currentAccountRoutes.get(
  "/parties/:partyId",
  requireAnyPermission(CURRENT_ACCOUNT_READ),
  async (c) => {
    const partyId = idSchema.safeParse(c.req.param("partyId"))
    if (!partyId.success) {
      return c.json({ success: false, error: "partyId inválido" }, 400)
    }
    const direction = z
      .enum(["receivable", "payable"])
      .safeParse(c.req.query("direction") || undefined)
    if (!direction.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getCurrentAccountLedger(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      direction.data,
      partyId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

currentAccountRoutes.patch(
  "/enrollment",
  requireMutationPermission(CURRENT_ACCOUNT_CREATE),
  async (c) => {
    const body = enrollmentBodySchema.safeParse(
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
    const result = await setCurrentAccountEnrollment(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

currentAccountRoutes.post(
  "/settle",
  requireMutationPermission(CURRENT_ACCOUNT_CREATE),
  async (c) => {
    const body = settleBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json(
        {
          success: false,
          error: body.error.issues[0]?.message ?? "Body inválido",
        },
        400,
      )
    }
    const sidecar = c.get("sidecar")
    const result = await settleCurrentAccount(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      c.get("userId"),
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

currentAccountRoutes.post(
  "/apply",
  requireMutationPermission(CURRENT_ACCOUNT_CREATE),
  async (c) => {
    const body = applyCreditBodySchema.safeParse(
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
    const sidecar = c.get("sidecar")
    const result = await applyCurrentAccountCredit(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
