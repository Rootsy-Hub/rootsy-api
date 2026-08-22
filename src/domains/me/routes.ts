import { Hono } from "hono"
import type { PrivateAuthEnv } from "../../auth/private.js"
import { listMyPops } from "./pops.js"
import { getMeProfile } from "./profile.js"

export const meRoutes = new Hono<PrivateAuthEnv>()

meRoutes.get("/", async (c) => {
  const result = await getMeProfile(c.get("supabase"), c.get("userId"))
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

meRoutes.get("/pops", async (c) => {
  const result = await listMyPops(c.get("supabase"), c.get("userId"))
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})
