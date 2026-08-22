import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { hasAnyPermission, requireAnyPermission } from "../../sidecar/permissions.js"
import {
  REPORT_EXPENSES,
  REPORT_INVOICES,
  REPORT_PURCHASES,
  REPORT_READ,
  REPORT_SALES,
} from "./allowlist.js"
import {
  getBalanceSheet,
  getCashFlow,
  getFinancialSummaries,
  getIncomeStatement,
  getTrialBalance,
  getVatPosition,
} from "./accounting.js"
import { getChartOfAccountsReport, searchChartAccounts } from "./chart.js"
import {
  getJournalEntries,
  getJournalEntryLines,
  getJournalTotals,
} from "./journal.js"
import { getLedgerPage, getLedgerTotals } from "./ledger.js"
import { getOperationalTotals } from "./operationalTotals.js"
import {
  asOfQuerySchema,
  chartSearchQuerySchema,
  journalQuerySchema,
  ledgerQuerySchema,
  periodQuerySchema,
  totalsQuerySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const reportRoutes = new Hono<SidecarEnv>()

function periodFromQuery(c: { req: { query: (k: string) => string | undefined } }) {
  return periodQuerySchema.safeParse({
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  })
}

reportRoutes.get(
  "/totals",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = totalsQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const kindAllow =
      parsed.data.kind === "sales"
        ? REPORT_SALES
        : parsed.data.kind === "expenses"
          ? REPORT_EXPENSES
          : parsed.data.kind === "issued-invoices"
            ? REPORT_INVOICES
            : parsed.data.kind === "purchases" ||
                parsed.data.kind === "received-invoices"
              ? REPORT_PURCHASES
              : REPORT_READ
    if (!hasAnyPermission(sidecar.keys, kindAllow, sidecar.isOwner)) {
      return c.json({ success: false, error: "Sin permiso" }, 403)
    }
    const result = await getOperationalTotals(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      parsed.data.kind,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

reportRoutes.get(
  "/trial-balance",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = periodFromQuery(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getTrialBalance(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json({ success: true, data: { rows: result.rows } })
  },
)

reportRoutes.get(
  "/income-statement",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = periodFromQuery(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getIncomeStatement(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

reportRoutes.get(
  "/balance-sheet",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = asOfQuerySchema.safeParse({
      asOf: c.req.query("asOf") || c.req.query("to") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getBalanceSheet(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.asOf,
    )
    if (!result.success) {
      return c.json(result, result.error.includes("Indicá") ? 400 : 500)
    }
    return c.json(result)
  },
)

reportRoutes.get(
  "/cash-flow",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = periodFromQuery(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getCashFlow(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json({ success: true, data: { rows: result.rows } })
  },
)

reportRoutes.get(
  "/vat-position",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = periodFromQuery(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getVatPosition(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json({ success: true, data: { rows: result.rows } })
  },
)

reportRoutes.get(
  "/summaries",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = periodFromQuery(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getFinancialSummaries(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json({ success: true, data: { summaries: result.summaries } })
  },
)

reportRoutes.get(
  "/journal/totals",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = periodFromQuery(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getJournalTotals(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

reportRoutes.get(
  "/journal",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = journalQuerySchema.safeParse({
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
      page: c.req.query("page") || undefined,
      pageSize: c.req.query("pageSize") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getJournalEntries(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.from,
      parsed.data.to,
      parsed.data.page,
      parsed.data.pageSize,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

reportRoutes.get(
  "/journal/:entryId/lines",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("entryId"))
    if (!id.success) {
      return c.json({ success: false, error: "entryId inválido" }, 400)
    }
    const result = await getJournalEntryLines(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) {
      return c.json(result, result.error.includes("no encontrado") ? 404 : 500)
    }
    return c.json({ success: true, data: { lines: result.lines } })
  },
)

reportRoutes.get(
  "/ledger/totals",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = ledgerQuerySchema.safeParse({
      accountCode: c.req.query("accountCode") || undefined,
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
      page: "1",
      pageSize: "40",
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getLedgerTotals(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.accountCode,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 400)
    return c.json(result)
  },
)

reportRoutes.get(
  "/ledger",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = ledgerQuerySchema.safeParse({
      accountCode: c.req.query("accountCode") || undefined,
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
      page: c.req.query("page") || undefined,
      pageSize: c.req.query("pageSize") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getLedgerPage(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.accountCode,
      parsed.data.from,
      parsed.data.to,
      parsed.data.page,
      parsed.data.pageSize,
    )
    if (!result.success) return c.json(result, 400)
    return c.json(result)
  },
)

reportRoutes.get(
  "/chart-of-accounts/search",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = chartSearchQuerySchema.safeParse({
      q: c.req.query("q") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await searchChartAccounts(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.q,
    )
    if (!result.success) return c.json(result, 500)
    return c.json({ success: true, data: { accounts: result.accounts } })
  },
)

reportRoutes.get(
  "/chart-of-accounts",
  requireAnyPermission(REPORT_READ),
  async (c) => {
    const parsed = asOfQuerySchema.safeParse({
      asOf: c.req.query("asOf") || c.req.query("to") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getChartOfAccountsReport(
      c.get("supabase"),
      sidecar.popId,
      parsed.data.asOf,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)
