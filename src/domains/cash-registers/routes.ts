import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  CASH_REGISTER_CREATE,
  CASH_REGISTER_DELETE,
  CASH_REGISTER_READ,
  CASH_REGISTER_UPDATE,
} from "./allowlist.js"
import { closeCashSession } from "./close.js"
import {
  addCashMovement,
  createCashRegister,
  deleteCashRegister,
  openCashSession,
  updateCashRegister,
} from "./mutations.js"
import { getCashRegistersOpenTotals } from "./openTotals.js"
import { getCashRegistersPeriodReport, getCashRegistersPeriodTotals } from "./period.js"
import { getCashRegistersFormContext, listCashRegisters } from "./queries.js"
import {
  addMovementBodySchema,
  closeSessionBodySchema,
  createCashRegisterBodySchema,
  openSessionBodySchema,
  periodQuerySchema,
  updateCashRegisterBodySchema,
} from "./schema.js"
import { getCashRegisterSessionArqueo } from "./arqueo.js"
import { getCashRegisterPage, getCashRegisterTotals } from "./summary.js"

export const cashRegisterRoutes = new Hono<SidecarEnv>()

const idSchema = z.string().uuid()

function parsePeriod(c: { req: { query: (k: string) => string | undefined } }) {
  return periodQuerySchema.safeParse({
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  })
}

function bodyError(issues: { message: string }[]) {
  return {
    success: false as const,
    error: issues[0]?.message ?? "Body inválido",
  }
}

cashRegisterRoutes.get(
  "/period/totals",
  requireAnyPermission(CASH_REGISTER_READ),
  async (c) => {
    const parsed = parsePeriod(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getCashRegistersPeriodTotals(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

cashRegisterRoutes.get(
  "/period",
  requireAnyPermission(CASH_REGISTER_READ),
  async (c) => {
    const parsed = parsePeriod(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getCashRegistersPeriodReport(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

cashRegisterRoutes.get(
  "/open-totals",
  requireAnyPermission(CASH_REGISTER_READ),
  async (c) => {
    const result = await getCashRegistersOpenTotals(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

cashRegisterRoutes.get(
  "/form-context",
  requireAnyPermission(CASH_REGISTER_READ),
  async (c) => {
    const result = await getCashRegistersFormContext(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

cashRegisterRoutes.get("/", requireAnyPermission(CASH_REGISTER_READ), async (c) => {
  const sidecar = c.get("sidecar")
  const result = await listCashRegisters(
    c.get("supabase"),
    sidecar.popId,
    c.get("userId"),
    sidecar.keys,
    sidecar.isOwner,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

cashRegisterRoutes.post("/", requireAnyPermission(CASH_REGISTER_CREATE), async (c) => {
  const body = createCashRegisterBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const result = await createCashRegister(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

cashRegisterRoutes.get(
  "/sessions/:sessionId/arqueo",
  requireAnyPermission(CASH_REGISTER_READ),
  async (c) => {
    const sessionId = idSchema.safeParse(c.req.param("sessionId"))
    if (!sessionId.success) {
      return c.json({ success: false, error: "Turno inválido" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getCashRegisterSessionArqueo(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      sessionId.data,
      sidecar.keys,
      sidecar.isOwner,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

cashRegisterRoutes.post(
  "/sessions/:sessionId/close",
  requireAnyPermission(CASH_REGISTER_UPDATE),
  async (c) => {
    const sessionId = idSchema.safeParse(c.req.param("sessionId"))
    if (!sessionId.success) {
      return c.json({ success: false, error: "Turno inválido" }, 400)
    }
    const body = closeSessionBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const sidecar = c.get("sidecar")
    const result = await closeCashSession(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      sessionId.data,
      c.get("userId"),
      sidecar.keys,
      sidecar.isOwner,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

cashRegisterRoutes.post(
  "/sessions/:sessionId/movements",
  requireAnyPermission(CASH_REGISTER_CREATE),
  async (c) => {
    const sessionId = idSchema.safeParse(c.req.param("sessionId"))
    if (!sessionId.success) {
      return c.json({ success: false, error: "Turno inválido" }, 400)
    }
    const body = addMovementBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await addCashMovement(
      c.get("supabase"),
      c.get("sidecar").popId,
      sessionId.data,
      c.get("userId"),
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

cashRegisterRoutes.get(
  "/:registerId/totals",
  requireAnyPermission(CASH_REGISTER_READ),
  async (c) => {
    const registerId = idSchema.safeParse(c.req.param("registerId"))
    if (!registerId.success) {
      return c.json({ success: false, error: "Caja inválida" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getCashRegisterTotals(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      registerId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

cashRegisterRoutes.post(
  "/:registerId/sessions",
  requireAnyPermission(CASH_REGISTER_CREATE),
  async (c) => {
    const registerId = idSchema.safeParse(c.req.param("registerId"))
    if (!registerId.success) {
      return c.json({ success: false, error: "Caja inválida" }, 400)
    }
    const body = openSessionBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await openCashSession(
      c.get("supabase"),
      c.get("sidecar").popId,
      registerId.data,
      c.get("userId"),
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

cashRegisterRoutes.get(
  "/:registerId",
  requireAnyPermission(CASH_REGISTER_READ),
  async (c) => {
    const registerId = idSchema.safeParse(c.req.param("registerId"))
    if (!registerId.success) {
      return c.json({ success: false, error: "Caja inválida" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getCashRegisterPage(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      registerId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

cashRegisterRoutes.patch(
  "/:registerId",
  requireAnyPermission(CASH_REGISTER_UPDATE),
  async (c) => {
    const registerId = idSchema.safeParse(c.req.param("registerId"))
    if (!registerId.success) {
      return c.json({ success: false, error: "Caja inválida" }, 400)
    }
    const body = updateCashRegisterBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await updateCashRegister(
      c.get("supabase"),
      c.get("sidecar").popId,
      registerId.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

cashRegisterRoutes.delete(
  "/:registerId",
  requireAnyPermission(CASH_REGISTER_DELETE),
  async (c) => {
    const registerId = idSchema.safeParse(c.req.param("registerId"))
    if (!registerId.success) {
      return c.json({ success: false, error: "Caja inválida" }, 400)
    }
    const result = await deleteCashRegister(
      c.get("supabase"),
      c.get("sidecar").popId,
      registerId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
