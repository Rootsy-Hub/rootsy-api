import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { INVOICE_READ } from "./allowlist.js"
import { listInvoices } from "./queries.js"
import { listInvoicesQuerySchema, toListInvoicesQuery } from "./schema.js"

function invoiceCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`invoices:${action}`)
  return {
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

export const invoiceRoutes = new Hono<SidecarEnv>()

invoiceRoutes.get("/", requireAnyPermission(INVOICE_READ), async (c) => {
  const parsed = listInvoicesQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    status: c.req.query("status") || undefined,
    cbteTipo: c.req.query("cbteTipo") || undefined,
    dateFrom: c.req.query("dateFrom") || undefined,
    dateTo: c.req.query("dateTo") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const sidecar = c.get("sidecar")
  const result = await listInvoices(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    toListInvoicesQuery(parsed.data),
    invoiceCaps(sidecar),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})
