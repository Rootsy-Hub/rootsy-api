import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { INVOICE_READ } from "./allowlist.js"
import {
  invoiceListResponseSchema,
  listInvoicesQuerySchema,
} from "./schema.js"

const tags = ["Comprobantes"]
const read = [requireAnyPermission(INVOICE_READ)] as const

export const listInvoicesRoute = documentedRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Listar comprobantes",
  description:
    "Paginado. Filtros por estado, tipo ARCA y fechas. Permiso `invoices:read`.",
  middleware: read,
  query: listInvoicesQuerySchema,
  success: invoiceListResponseSchema,
  successDescription: "Listado paginado de comprobantes ARCA.",
})
