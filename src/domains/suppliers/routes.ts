import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { SUPPLIER_READ } from "./allowlist.js"
import { listSupplierOptions } from "./queries.js"
import { listSuppliersQuerySchema } from "./schema.js"

export const supplierRoutes = new Hono<SidecarEnv>()

supplierRoutes.get("/", requireAnyPermission(SUPPLIER_READ), async (c) => {
  const parsed = listSuppliersQuerySchema.safeParse({
    q: c.req.query("q") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listSupplierOptions(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.data,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})
