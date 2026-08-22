import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  DOCK_CREATE,
  DOCK_DELETE,
  DOCK_READ,
  DOCK_UPDATE,
} from "./allowlist.js"
import { createDock, deleteDock, getDock, updateDock } from "./queries.js"
import { createDockBodySchema, updateDockBodySchema } from "./schema.js"

export const dockRoutes = new Hono<SidecarEnv>()

dockRoutes.get("/", requireAnyPermission(DOCK_READ), async (c) => {
  const result = await getDock(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

dockRoutes.post("/", requireAnyPermission(DOCK_CREATE), async (c) => {
  const body = createDockBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await createDock(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

dockRoutes.patch("/", requireAnyPermission(DOCK_UPDATE), async (c) => {
  const body = updateDockBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await updateDock(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

dockRoutes.delete("/", requireAnyPermission(DOCK_DELETE), async (c) => {
  const result = await deleteDock(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})
