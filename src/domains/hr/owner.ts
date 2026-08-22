import type { MiddlewareHandler } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"

export const requireOwner: MiddlewareHandler<SidecarEnv> = async (c, next) => {
  if (!c.get("sidecar").isOwner) {
    return c.json({ success: false, error: "Sin permiso" }, 403)
  }
  await next()
}
