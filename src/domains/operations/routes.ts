import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { OPERATION_READ, OPERATION_READ_OR_SALE } from "./allowlist.js"
import {
  getChannelOperationTicketDisplay,
  getOperationAccountingEntries,
  getOperationPurchaseById,
  getOperationSaleById,
  getOperationSaleDetailCharges,
  getOperationSaleDetailContext,
} from "./details.js"
import { getOperationsList } from "./queries.js"
import {
  accountingQuerySchema,
  listInputFromQuery,
  listOperationsQuerySchema,
  saleChargesQuerySchema,
  ticketQuerySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const operationRoutes = new Hono<SidecarEnv>()

operationRoutes.get("/", requireAnyPermission(OPERATION_READ), async (c) => {
  const parsed = listOperationsQuerySchema.safeParse({
    view: c.req.query("view") || undefined,
    dateFrom: c.req.query("dateFrom") || undefined,
    dateTo: c.req.query("dateTo") || undefined,
    q: c.req.query("q") || undefined,
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
    fiscalOnly: c.req.query("fiscalOnly") || undefined,
    saleStatus: c.req.query("saleStatus") || undefined,
    saleWithDiscount: c.req.query("saleWithDiscount") || undefined,
    tableSession: c.req.query("tableSession") || undefined,
    counterStatus: c.req.query("counterStatus") || undefined,
    counterFulfillment: c.req.query("counterFulfillment") || undefined,
    purchaseKind: c.req.query("purchaseKind") || undefined,
    expenseSource: c.req.query("expenseSource") || undefined,
    serviceStatus: c.req.query("serviceStatus") || undefined,
    serviceScope: c.req.query("serviceScope") || undefined,
    include: c.req.query("include") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const sidecar = c.get("sidecar")
  const result = await getOperationsList(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    listInputFromQuery(parsed.data),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

operationRoutes.get(
  "/purchases/:purchaseId",
  requireAnyPermission(OPERATION_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("purchaseId"))
    if (!id.success) {
      return c.json({ success: false, error: "purchaseId inválido" }, 400)
    }
    const result = await getOperationPurchaseById(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) {
      return c.json(result, result.error.includes("No se encontró") ? 404 : 500)
    }
    return c.json(result)
  },
)

operationRoutes.get(
  "/sales/:saleId",
  requireAnyPermission(OPERATION_READ_OR_SALE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("saleId"))
    if (!id.success) {
      return c.json({ success: false, error: "saleId inválido" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getOperationSaleById(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      id.data,
    )
    if (!result.success) {
      return c.json(result, result.error.includes("No se encontró") ? 404 : 500)
    }
    return c.json(result)
  },
)

operationRoutes.get(
  "/sales/:saleId/charges",
  requireAnyPermission(OPERATION_READ_OR_SALE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("saleId"))
    if (!id.success) {
      return c.json({ success: false, error: "saleId inválido" }, 400)
    }
    const parsed = saleChargesQuerySchema.safeParse({
      groupedSaleIds: c.req.query("groupedSaleIds") || undefined,
      tableSessionId: c.req.query("tableSessionId") || undefined,
      counterOrderId: c.req.query("counterOrderId") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getOperationSaleDetailCharges(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      {
        saleId: id.data,
        groupedSaleIds: parsed.data.groupedSaleIds,
        tableSessionId: parsed.data.tableSessionId,
        counterOrderId: parsed.data.counterOrderId,
      },
    )
    if (!result.success) {
      return c.json(result, result.error.includes("No se encontr") ? 404 : 500)
    }
    return c.json(result)
  },
)

operationRoutes.get(
  "/sales/:saleId/context",
  requireAnyPermission(OPERATION_READ_OR_SALE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("saleId"))
    if (!id.success) {
      return c.json({ success: false, error: "saleId inválido" }, 400)
    }
    const result = await getOperationSaleDetailContext(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) {
      return c.json(result, result.error.includes("No se encontró") ? 404 : 500)
    }
    return c.json(result)
  },
)

operationRoutes.get(
  "/accounting",
  requireAnyPermission(OPERATION_READ),
  async (c) => {
    const parsed = accountingQuerySchema.safeParse({
      view: c.req.query("view") || undefined,
      operationId: c.req.query("operationId") || undefined,
      groupedSaleIds: c.req.query("groupedSaleIds") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await getOperationAccountingEntries(
      c.get("supabase"),
      c.get("sidecar").popId,
      {
        view: parsed.data.view,
        operationId: parsed.data.operationId,
        groupedSaleIds: parsed.data.groupedSaleIds,
      },
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

// TODO: devolver `ticket` con buildChannelCheckoutTicketDisplay + catálogo slim
// (articles, recipes, promotions, quantity deals). El builder y sus deps
// (menuCheckoutPromotions, mostradorCartDisplay, promotionPricing, etc.) son
// demasiado grandes para portar ahora. GET /ticket lee metadata de
// table_sessions / counter_orders, parsea el checkout y lo devuelve.
operationRoutes.get("/ticket", requireAnyPermission(OPERATION_READ), async (c) => {
  const parsed = ticketQuerySchema.safeParse({
    tableSessionId: c.req.query("tableSessionId") || undefined,
    counterOrderId: c.req.query("counterOrderId") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  if (!parsed.data.tableSessionId && !parsed.data.counterOrderId) {
    return c.json(
      { success: false, error: "Operación de canal inválida." },
      400,
    )
  }
  const result = await getChannelOperationTicketDisplay(
    c.get("supabase"),
    c.get("sidecar").popId,
    {
      tableSessionId: parsed.data.tableSessionId,
      counterOrderId: parsed.data.counterOrderId,
    },
  )
  if (!result.success) {
    return c.json(result, result.error.includes("No se encontr") || result.error.includes("No hay ticket") ? 404 : 500)
  }
  return c.json(result)
})
