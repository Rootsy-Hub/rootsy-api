import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  PRINTER_CREATE,
  PRINTER_DELETE,
  PRINTER_READ,
  PRINTER_UPDATE,
} from "./allowlist.js"
import {
  createPrinter,
  deletePrinter,
  getPrinter,
  listPrinters,
  updatePrinter,
} from "./queries.js"
import { upsertPrinterBodySchema } from "./schema.js"

const idSchema = z.string().uuid()

export const printerRoutes = new Hono<SidecarEnv>()

function bodyError(issues: { message: string }[]) {
  return {
    success: false as const,
    error: issues[0]?.message ?? "Body inválido",
  }
}

printerRoutes.get("/", requireAnyPermission(PRINTER_READ), async (c) => {
  const result = await listPrinters(c.get("supabase"), c.get("sidecar").popId)
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

printerRoutes.post("/", requireAnyPermission(PRINTER_CREATE), async (c) => {
  const body = upsertPrinterBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const result = await createPrinter(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
  )
  if (!result.success) return c.json(result, result.status ?? 500)
  return c.json(result, 201)
})

printerRoutes.get(
  "/:printerId",
  requireAnyPermission(PRINTER_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("printerId"))
    if (!id.success) {
      return c.json({ success: false, error: "printerId inválido" }, 400)
    }
    const result = await getPrinter(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

printerRoutes.patch(
  "/:printerId",
  requireAnyPermission(PRINTER_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("printerId"))
    if (!id.success) {
      return c.json({ success: false, error: "printerId inválido" }, 400)
    }
    const body = upsertPrinterBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await updatePrinter(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

printerRoutes.delete(
  "/:printerId",
  requireAnyPermission(PRINTER_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("printerId"))
    if (!id.success) {
      return c.json({ success: false, error: "printerId inválido" }, 400)
    }
    const result = await deletePrinter(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
