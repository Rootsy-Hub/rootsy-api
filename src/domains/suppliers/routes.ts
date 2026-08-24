import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  SUPPLIER_CREATE,
  SUPPLIER_DELETE,
  SUPPLIER_READ,
  SUPPLIER_TABLE_READ,
  SUPPLIER_UPDATE,
} from "./allowlist.js"
import {
  createSupplier,
  deleteSupplier,
  updateSupplier,
} from "./mutations.js"
import { listSupplierOptions, listSuppliersTable } from "./queries.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  deleteSupplierBodySchema,
  listSuppliersQuerySchema,
  listSuppliersTableQuerySchema,
  toListSuppliersTableQuery,
  upsertSupplierBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

function supplierCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`suppliers:${action}`)
  return {
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

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

supplierRoutes.get("/table", requireAnyPermission(SUPPLIER_TABLE_READ), async (c) => {
  const parsed = listSuppliersTableQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    soloActivos: c.req.query("soloActivos") || undefined,
    withEmail: c.req.query("withEmail") || undefined,
    withTaxId: c.req.query("withTaxId") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listSuppliersTable(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListSuppliersTableQuery(parsed.data),
    supplierCaps(c.get("sidecar")),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

supplierRoutes.post("/", requireMutationPermission(SUPPLIER_CREATE), async (c) => {
  const body = upsertSupplierBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await createSupplier(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

supplierRoutes.patch(
  "/:supplierId",
  requireMutationPermission(SUPPLIER_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("supplierId"))
    if (!id.success) {
      return c.json({ success: false, error: "supplierId inválido" }, 400)
    }
    const body = parsePatchBody(
      upsertSupplierBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const result = await updateSupplier(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

supplierRoutes.delete(
  "/:supplierId",
  requireMutationPermission(SUPPLIER_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("supplierId"))
    if (!id.success) {
      return c.json({ success: false, error: "supplierId inválido" }, 400)
    }
    const body = deleteSupplierBodySchema.safeParse(
      await c.req.json().catch(() => ({ confirmationTyped: "" })),
    )
    if (!body.success) {
      return c.json(
        {
          success: false,
          error: body.error.issues[0]?.message ?? "Body inválido",
        },
        400,
      )
    }
    const result = await deleteSupplier(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data.confirmationTyped,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
