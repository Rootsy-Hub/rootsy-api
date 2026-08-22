import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { TREASURY_READ } from "./allowlist.js"
import { getTreasuryPeriodReport, getTreasuryPeriodTotals } from "./period.js"
import { periodQuerySchema } from "./schema.js"

export const treasuryRoutes = new Hono<SidecarEnv>()

function parsePeriod(c: { req: { query: (k: string) => string | undefined } }) {
  return periodQuerySchema.safeParse({
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  })
}

treasuryRoutes.get(
  "/period/totals",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const parsed = parsePeriod(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await getTreasuryPeriodTotals(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

treasuryRoutes.get(
  "/period",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const parsed = parsePeriod(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await getTreasuryPeriodReport(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)
