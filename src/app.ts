import { Hono } from "hono"
import { requirePrivateAuth, type PrivateAuthEnv } from "./auth/private.js"
import { meRoutes } from "./domains/me/routes.js"
import { articleRoutes } from "./domains/articles/routes.js"
import { categoryRoutes } from "./domains/categories/routes.js"
import { clientRoutes } from "./domains/clients/routes.js"
import { dockRoutes } from "./domains/dock/routes.js"
import { expenseCategoryRoutes } from "./domains/expense-categories/routes.js"
import { expenseRoutes } from "./domains/expenses/routes.js"
import { priceListRoutes } from "./domains/price-lists/routes.js"
import { comandaStationRoutes } from "./domains/comanda-stations/routes.js"
import { recipeCategoryRoutes } from "./domains/recipe-categories/routes.js"
import { printerRoutes } from "./domains/printers/routes.js"
import { promotionRoutes } from "./domains/promotions/routes.js"
import { recipeRoutes } from "./domains/recipes/routes.js"
import { serviceCategoryRoutes } from "./domains/service-categories/routes.js"
import { serviceRoutes } from "./domains/services/routes.js"
import { supplierRoutes } from "./domains/suppliers/routes.js"
import { invoiceRoutes } from "./domains/invoices/routes.js"
import { arcaSalePointRoutes } from "./domains/arca-sale-points/routes.js"
import { quoteRoutes } from "./domains/quotes/routes.js"
import { purchaseOrderRoutes } from "./domains/purchase-orders/routes.js"
import { checkRoutes } from "./domains/checks/routes.js"
import { currentAccountRoutes } from "./domains/current-accounts/routes.js"
import { inventoryRoutes } from "./domains/inventory/routes.js"
import { operationRoutes } from "./domains/operations/routes.js"
import { reportRoutes } from "./domains/reports/routes.js"
import { cashRegisterRoutes } from "./domains/cash-registers/routes.js"
import { statisticsRoutes } from "./domains/statistics/routes.js"
import { treasuryRoutes } from "./domains/treasury/routes.js"
import { settingsRoutes } from "./domains/settings/routes.js"
import { hrRoutes } from "./domains/hr/routes.js"
import { manufacturingRoutes } from "./domains/manufacturing/routes.js"
import { chatRoutes } from "./domains/chat/routes.js"
import { saleRoutes } from "./domains/sale/routes.js"
import { auditRoutes } from "./domains/audit/routes.js"
import { meApprovalCodeRoutes } from "./domains/me-approval-code/routes.js"
import { getEnv } from "./env.js"
import { isTimeoutError } from "./lib/fetchTimeout.js"
import { requireRequestTimeout } from "./lib/requestTimeout.js"
import type { RealtimeBindings } from "./realtime/bindings.js"
import {
  realtimePublishRoutes,
  realtimeWsRoutes,
} from "./realtime/routes.js"
import { requirePopSidecar, type SidecarEnv } from "./sidecar/pop.js"

export function createApp() {
  const app = new Hono<{ Bindings: RealtimeBindings }>()

  app.onError((err, c) => {
    if (c.finalized) return c.res
    if (isTimeoutError(err)) {
      return c.json({ success: false, error: "Timeout" }, 504)
    }
    return c.json({ success: false, error: "Error interno" }, 500)
  })

  app.get("/health", (c) => c.json({ ok: true }))
  app.get("/ping", (c) => c.json({ pong: true }))
  app.route("/realtime/pops/:popId", realtimeWsRoutes)

  const v1 = new Hono<PrivateAuthEnv>()
  v1.use("*", (c, next) =>
    requireRequestTimeout(getEnv().REQUEST_TIMEOUT_MS)(c, next),
  )
  v1.use("*", requirePrivateAuth)

  v1.route("/me", meRoutes)

  const pop = new Hono<SidecarEnv>()
  pop.use("*", requirePopSidecar)
  pop.route("/audit", auditRoutes)
  pop.route("/me/approval-code", meApprovalCodeRoutes)
  pop.route("/articles", articleRoutes)
  pop.route("/categories", categoryRoutes)
  pop.route("/clients", clientRoutes)
  pop.route("/comanda-stations", comandaStationRoutes)
  pop.route("/dock", dockRoutes)
  pop.route("/price-lists", priceListRoutes)
  pop.route("/expense-categories", expenseCategoryRoutes)
  pop.route("/expenses", expenseRoutes)
  pop.route("/recipe-categories", recipeCategoryRoutes)
  pop.route("/printers", printerRoutes)
  pop.route("/promotions", promotionRoutes)
  pop.route("/recipes", recipeRoutes)
  pop.route("/service-categories", serviceCategoryRoutes)
  pop.route("/services", serviceRoutes)
  pop.route("/suppliers", supplierRoutes)
  pop.route("/invoices", invoiceRoutes)
  pop.route("/arca-sale-points", arcaSalePointRoutes)
  pop.route("/quotes", quoteRoutes)
  pop.route("/purchase-orders", purchaseOrderRoutes)
  pop.route("/checks", checkRoutes)
  pop.route("/current-accounts", currentAccountRoutes)
  pop.route("/inventory", inventoryRoutes)
  pop.route("/operations", operationRoutes)
  pop.route("/reports", reportRoutes)
  pop.route("/cash-registers", cashRegisterRoutes)
  pop.route("/statistics", statisticsRoutes)
  pop.route("/treasury", treasuryRoutes)
  pop.route("/settings", settingsRoutes)
  pop.route("/hr", hrRoutes)
  pop.route("/manufacturing", manufacturingRoutes)
  pop.route("/chat", chatRoutes)
  pop.route("/sale", saleRoutes)
  pop.route("/realtime", realtimePublishRoutes)

  v1.route("/pops/:popId", pop)
  app.route("/v1", v1)

  return app
}
