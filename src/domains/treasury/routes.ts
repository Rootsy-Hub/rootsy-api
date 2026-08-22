import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  TREASURY_CREATE,
  TREASURY_DELETE,
  TREASURY_READ,
  TREASURY_UPDATE,
} from "./allowlist.js"
import { getTreasuryAccountBalances } from "./balances.js"
import { getTreasuryReconciliationHistory } from "./history.js"
import {
  clearMovementReconciliation,
  setMovementReconciliation,
} from "./marks.js"
import { getTreasuryAccountMovements } from "./movements.js"
import {
  createTreasuryAccount,
  createTreasuryChildAccount,
  deleteTreasuryAccount,
  setTreasuryAccountActive,
  updateTreasuryAccount,
} from "./mutations.js"
import { getTreasuryPeriodReport, getTreasuryPeriodTotals } from "./period.js"
import { getTreasuryAccountPage, listTreasuryAccounts } from "./queries.js"
import {
  childPendingQuerySchema,
  clearReconciliationMarkBodySchema,
  createTreasuryAccountBodySchema,
  createTreasuryChildBodySchema,
  periodQuerySchema,
  posAcreditationBodySchema,
  reconciliationHistoryQuerySchema,
  reconciliationMarkBodySchema,
  setTreasuryAccountActiveBodySchema,
  settlementBodySchema,
  statementImportBodySchema,
  statementLineBodySchema,
  updateTreasuryAccountBodySchema,
} from "./schema.js"
import {
  getChildPendingBalance,
  recordPosAcreditation,
  recordTreasurySettlement,
} from "./settlements.js"
import {
  addManualBankStatementLine,
  deleteBankStatementLine,
  importBankStatementCsv,
} from "./statement.js"
import { getTreasuryAccountTotals } from "./totals.js"

export const treasuryRoutes = new Hono<SidecarEnv>()

const accountIdSchema = z.string().uuid()

function parsePeriod(c: { req: { query: (k: string) => string | undefined } }) {
  return periodQuerySchema.safeParse({
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  })
}

function parseRelatedIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => accountIdSchema.safeParse(id).success)
}

function bodyError(issues: { message: string }[]) {
  return {
    success: false as const,
    error: issues[0]?.message ?? "Body inválido",
  }
}

treasuryRoutes.get(
  "/period/totals",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const parsed = parsePeriod(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await getTreasuryPeriodTotals(
      c.get("supabase"),
      c.get("sidecar").popId,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

treasuryRoutes.get("/period", requireAnyPermission(TREASURY_READ), async (c) => {
  const parsed = parsePeriod(c)
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const result = await getTreasuryPeriodReport(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.data.from,
    parsed.data.to,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

treasuryRoutes.get(
  "/balances",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const result = await getTreasuryAccountBalances(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

treasuryRoutes.get("/", requireAnyPermission(TREASURY_READ), async (c) => {
  const result = await listTreasuryAccounts(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

treasuryRoutes.post("/", requireAnyPermission(TREASURY_CREATE), async (c) => {
  const body = createTreasuryAccountBodySchema.safeParse(
    await c.req.json().catch(() => null),
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
  const result = await createTreasuryAccount(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

treasuryRoutes.get(
  "/:accountId/totals",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const parsed = parsePeriod(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const result = await getTreasuryAccountTotals(
      c.get("supabase"),
      c.get("sidecar").popId,
      accountId.data,
      parsed.data.from,
      parsed.data.to,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.get(
  "/:accountId/movements",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const parsed = parsePeriod(c)
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getTreasuryAccountMovements(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      accountId.data,
      parsed.data.from,
      parsed.data.to,
      parseRelatedIds(c.req.query("related")),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.get(
  "/:accountId/children/:childId/pending",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    const childId = accountIdSchema.safeParse(c.req.param("childId"))
    if (!accountId.success || !childId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const parsed = childPendingQuerySchema.safeParse({
      asOf: c.req.query("asOf"),
      role: c.req.query("role"),
    })
    if (!parsed.success) {
      return c.json(bodyError(parsed.error.issues), 400)
    }
    const result = await getChildPendingBalance(
      c.get("supabase"),
      c.get("sidecar").popId,
      childId.data,
      parsed.data.role,
      parsed.data.asOf,
    )
    return c.json(result)
  },
)

treasuryRoutes.get(
  "/:accountId/reconciliation",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const parsed = reconciliationHistoryQuerySchema.safeParse({
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
      child: c.req.query("child") || undefined,
      role: c.req.query("role") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await getTreasuryReconciliationHistory(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      accountId.data,
      {
        childTreasuryAccountId: parsed.data.child,
        childRole: parsed.data.role,
        dateFrom: parsed.data.from,
        dateTo: parsed.data.to,
      },
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.post(
  "/:accountId/statement/import",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const body = statementImportBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await importBankStatementCsv(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      accountId.data,
      body.data.csvText,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.post(
  "/:accountId/statement",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const body = statementLineBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await addManualBankStatementLine(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      accountId.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

treasuryRoutes.delete(
  "/:accountId/statement/:lineId",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    const lineId = accountIdSchema.safeParse(c.req.param("lineId"))
    if (!accountId.success || !lineId.success) {
      return c.json({ success: false, error: "Identificador inválido" }, 400)
    }
    const result = await deleteBankStatementLine(
      c.get("supabase"),
      c.get("sidecar").popId,
      accountId.data,
      lineId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.post(
  "/:accountId/reconciliation-marks",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const body = reconciliationMarkBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await setMovementReconciliation(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      accountId.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.delete(
  "/:accountId/reconciliation-marks",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const body = clearReconciliationMarkBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await clearMovementReconciliation(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data.movementKind,
      body.data.movementRefId,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.post(
  "/:accountId/settlements",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const body = settlementBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await recordTreasurySettlement(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

treasuryRoutes.post(
  "/:accountId/pos-acreditations",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const body = posAcreditationBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await recordPosAcreditation(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      accountId.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

treasuryRoutes.get(
  "/:accountId",
  requireAnyPermission(TREASURY_READ),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const result = await getTreasuryAccountPage(
      c.get("supabase"),
      c.get("sidecar").popId,
      accountId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.patch(
  "/:accountId/active",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const body = setTreasuryAccountActiveBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: "Body inválido" }, 400)
    }
    const result = await setTreasuryAccountActive(
      c.get("supabase"),
      c.get("sidecar").popId,
      accountId.data,
      body.data.isActive,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.patch(
  "/:accountId",
  requireAnyPermission(TREASURY_UPDATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const body = updateTreasuryAccountBodySchema.safeParse(
      await c.req.json().catch(() => null),
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
    const result = await updateTreasuryAccount(
      c.get("supabase"),
      c.get("sidecar").popId,
      accountId.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.post(
  "/:accountId/children",
  requireAnyPermission(TREASURY_CREATE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const body = createTreasuryChildBodySchema.safeParse(
      await c.req.json().catch(() => null),
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
    const result = await createTreasuryChildAccount(
      c.get("supabase"),
      c.get("sidecar").popId,
      accountId.data,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

treasuryRoutes.delete(
  "/:accountId",
  requireAnyPermission(TREASURY_DELETE),
  async (c) => {
    const accountId = accountIdSchema.safeParse(c.req.param("accountId"))
    if (!accountId.success) {
      return c.json({ success: false, error: "Cuenta inválida" }, 400)
    }
    const result = await deleteTreasuryAccount(
      c.get("supabase"),
      c.get("sidecar").popId,
      accountId.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
