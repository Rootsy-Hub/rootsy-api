import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { z } from "zod"
import { requirePrivateAuth, type PrivateAuthEnv } from "./auth/private.js"
import { getEnv } from "./env.js"
import { requireMesasLayoutAccess } from "./lib/popAccess.js"
import { loadMesasLayout } from "./modules/mesas/layout.js"

const layoutQuerySchema = z.object({
  siteId: z.string().trim().min(1),
})

const popIdSchema = z.string().uuid()

const app = new Hono()

app.get("/health", (c) => c.json({ ok: true }))

const v1 = new Hono<PrivateAuthEnv>()
v1.use("*", requirePrivateAuth)

v1.get("/pops/:popId/mesas/layout", async (c) => {
  const popParsed = popIdSchema.safeParse(c.req.param("popId"))
  const queryParsed = layoutQuerySchema.safeParse({
    siteId: c.req.query("siteId"),
  })
  if (!popParsed.success || !queryParsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const supabase = c.get("supabase")
  const userId = c.get("userId")
  const gate = await requireMesasLayoutAccess(
    supabase,
    userId,
    popParsed.data,
    queryParsed.data.siteId,
  )
  if (!gate.ok) {
    return c.json(
      { success: false, error: gate.error, redirect: gate.redirect },
      gate.status,
    )
  }

  const result = await loadMesasLayout(supabase, popParsed.data)
  if (!result.success) {
    return c.json(result, 500)
  }
  return c.json(result)
})

app.route("/v1", v1)

const env = getEnv()
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`rootsy-api escuchando en http://localhost:${info.port}`)
})
