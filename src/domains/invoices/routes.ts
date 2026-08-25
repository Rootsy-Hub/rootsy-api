import type { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput } from "../../openapi/valid.js"
import { listInvoices } from "./queries.js"
import { listInvoicesRoute } from "./openapi.js"
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

export const invoiceRoutes = createOpenApiApp<SidecarEnv>()

invoiceRoutes.openapi(listInvoicesRoute, async (c) => {
  const sidecar = c.get("sidecar")
  const result = await listInvoices(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    toListInvoicesQuery(
      routeInput<z.infer<typeof listInvoicesQuerySchema>>(c, "query"),
    ),
    invoiceCaps(sidecar),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})
