import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { CASH_REGISTER_READ } from "./allowlist.js"
import { getCashRegistersPeriodReport, getCashRegistersPeriodTotals } from "./period.js"
import { periodQuerySchema } from "./schema.js"

export const cashRegisterRoutes = new Hono<SidecarEnv>()

function parsePeriod(c: { req: { query: (k: string) => string | undefined } }) {
  return periodQuerySchema.safeParse({
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  })
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
