import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { STATISTICS_READ } from "./allowlist.js"
import { getStatisticsSection } from "./dispatch.js"
import {
  STATISTICS_SECTION_IDS,
  sectionQuerySchema,
  type StatisticsSectionId,
} from "./schema.js"

export const statisticsRoutes = new Hono<SidecarEnv>()

function parseSection(raw: string): StatisticsSectionId | null {
  return (STATISTICS_SECTION_IDS as readonly string[]).includes(raw)
    ? (raw as StatisticsSectionId)
    : null
}

function parseQuery(c: { req: { query: (k: string) => string | undefined } }) {
  return sectionQuerySchema.safeParse({
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
    prevFrom: c.req.query("prevFrom") || undefined,
    prevTo: c.req.query("prevTo") || undefined,
    channel: c.req.query("channel") || undefined,
    supplier: c.req.query("supplier") || undefined,
  })
}

for (const kind of ["summary", "details"] as const) {
  statisticsRoutes.get(
    `/:section/${kind}`,
    requireAnyPermission(STATISTICS_READ),
    async (c) => {
      const sectionId = parseSection(c.req.param("section"))
      if (!sectionId) {
        return c.json({ success: false, error: "Sección inválida" }, 400)
      }
      const parsed = parseQuery(c)
      if (!parsed.success) {
        return c.json({ success: false, error: "Parámetros inválidos" }, 400)
      }
      const sidecar = c.get("sidecar")
      const result = await getStatisticsSection(
        c.get("supabase"),
        sidecar.popId,
        sidecar.popSiteId,
        sectionId,
        kind,
        parsed.data,
      )
      if (!result.success) return c.json(result, 500)
      return c.json(result)
    },
  )
}
