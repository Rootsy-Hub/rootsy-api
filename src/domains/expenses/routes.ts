import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  EXPENSE_CREATE,
  EXPENSE_DELETE,
  EXPENSE_READ,
  EXPENSE_UPDATE,
} from "./allowlist.js"
import {
  createExpense,
  deleteExpense,
  recordExpensePayment,
  voidExpense,
} from "./mutations.js"
import { loadExpensePaymentContext } from "./paymentContext.js"
import { listExpensesForMonth } from "./queries.js"
import {
  createExpenseBodySchema,
  listExpensesQuerySchema,
  recordExpensePaymentBodySchema,
  voidExpenseBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const expenseRoutes = new Hono<SidecarEnv>()

expenseRoutes.get("/", requireAnyPermission(EXPENSE_READ), async (c) => {
  const parsed = listExpensesQuerySchema.safeParse({
    year: c.req.query("year") || undefined,
    month: c.req.query("month") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }
  const result = await listExpensesForMonth(
    c.get("supabase"),
    c.get("sidecar").popId,
    parsed.data,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

expenseRoutes.get(
  "/payment-context",
  requireAnyPermission(EXPENSE_UPDATE),
  async (c) => {
    const result = await loadExpensePaymentContext(
      c.get("supabase"),
      c.get("sidecar").popId,
    )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

expenseRoutes.post("/", requireMutationPermission(EXPENSE_CREATE), async (c) => {
  const body = createExpenseBodySchema.safeParse(
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
  const result = await createExpense(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

expenseRoutes.post(
  "/:expenseId/payments",
  requireMutationPermission(EXPENSE_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("expenseId"))
    if (!id.success) {
      return c.json({ success: false, error: "expenseId inválido" }, 400)
    }
    const body = recordExpensePaymentBodySchema.safeParse(
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
    const result = await recordExpensePayment(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      id.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

expenseRoutes.post(
  "/:expenseId/void",
  requireMutationPermission(EXPENSE_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("expenseId"))
    if (!id.success) {
      return c.json({ success: false, error: "expenseId inválido" }, 400)
    }
    const body = voidExpenseBodySchema.safeParse(
      await c.req.json().catch(() => ({ reason: "" })),
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
    const sidecar = c.get("sidecar")
    const result = await voidExpense(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      c.get("userId"),
      id.data,
      body.data.reason,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

expenseRoutes.delete(
  "/:expenseId",
  requireMutationPermission(EXPENSE_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("expenseId"))
    if (!id.success) {
      return c.json({ success: false, error: "expenseId inválido" }, 400)
    }
    const result = await deleteExpense(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
