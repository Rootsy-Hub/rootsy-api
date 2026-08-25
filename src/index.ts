import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { getEnv, initEnv } from "./env.js"

initEnv(process.env)
const app = createApp()
const env = getEnv()

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`rootsy-api escuchando en http://localhost:${info.port}`)
  console.log(`docs: http://localhost:${info.port}/docs`)
})
