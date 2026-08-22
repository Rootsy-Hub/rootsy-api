import type { MiddlewareHandler } from "hono"
import type { SidecarEnv } from "./pop.js"

export function hasAnyPermission(
  keys: readonly string[],
  allowlist: readonly string[],
  isOwner: boolean,
): boolean {
  if (isOwner) return true
  return allowlist.some((key) => keys.includes(key))
}

export function requireAnyPermission(
  allowlist: readonly string[],
): MiddlewareHandler<SidecarEnv> {
  return async (c, next) => {
    const sidecar = c.get("sidecar")
    if (!sidecar) {
      return c.json({ success: false, error: "Sidecar ausente" }, 500)
    }
    if (!hasAnyPermission(sidecar.keys, allowlist, sidecar.isOwner)) {
      return c.json({ success: false, error: "Sin permiso" }, 403)
    }
    await next()
  }
}
