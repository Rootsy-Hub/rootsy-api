import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { requirePrivateAuth, type PrivateAuthEnv } from "./auth/private.js"
import { meRoutes } from "./domains/me/routes.js"
import { articleRoutes } from "./domains/articles/routes.js"
import { categoryRoutes } from "./domains/categories/routes.js"
import { dockRoutes } from "./domains/dock/routes.js"
import { expenseCategoryRoutes } from "./domains/expense-categories/routes.js"
import { priceListRoutes } from "./domains/price-lists/routes.js"
import { recipeCategoryRoutes } from "./domains/recipe-categories/routes.js"
import { serviceCategoryRoutes } from "./domains/service-categories/routes.js"
import { getEnv } from "./env.js"
import { isTimeoutError } from "./lib/fetchTimeout.js"
import { requireRequestTimeout } from "./lib/requestTimeout.js"
import { requirePopSidecar, type SidecarEnv } from "./sidecar/pop.js"

const env = getEnv()
const app = new Hono()

app.onError((err, c) => {
  if (c.finalized) return c.res
  if (isTimeoutError(err)) {
    return c.json({ success: false, error: "Timeout" }, 504)
  }
  return c.json({ success: false, error: "Error interno" }, 500)
})

app.get("/health", (c) => c.json({ ok: true }))
app.get("/ping", (c) => c.json({ pong: true }))

const v1 = new Hono<PrivateAuthEnv>()
v1.use("*", requireRequestTimeout(env.REQUEST_TIMEOUT_MS))
v1.use("*", requirePrivateAuth)

v1.route("/me", meRoutes)

const pop = new Hono<SidecarEnv>()
pop.use("*", requirePopSidecar)
pop.route("/articles", articleRoutes)
pop.route("/categories", categoryRoutes)
pop.route("/dock", dockRoutes)
pop.route("/price-lists", priceListRoutes)
pop.route("/expense-categories", expenseCategoryRoutes)
pop.route("/recipe-categories", recipeCategoryRoutes)
pop.route("/service-categories", serviceCategoryRoutes)

v1.route("/pops/:popId", pop)
app.route("/v1", v1)

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`rootsy-api escuchando en http://localhost:${info.port}`)
})
