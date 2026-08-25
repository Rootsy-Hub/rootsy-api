import { z } from "@hono/zod-openapi"
import { documentedRoute } from "../../openapi/documentedRoute.js"
import { okDataSchema } from "../../openapi/schemas.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { OPERATE_OPEN_SESSION_READ } from "./allowlist.js"

const tags = ["Cajas"]

export const operateOpenCashSalePointSchema = z
  .object({
    id: z.string().uuid(),
    ptoVta: z.number().int(),
  })
  .openapi("OperateOpenCashSalePoint")

export const operateOpenCashSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    cashRegisterId: z.string().uuid(),
    openedAt: z.string(),
    salePoint: operateOpenCashSalePointSchema.nullable(),
  })
  .openapi("OperateOpenCashSession")

export const operateOpenCashSessionDataSchema = z
  .object({
    session: operateOpenCashSessionSchema.nullable(),
  })
  .openapi("OperateOpenCashSessionData")

export const operateOpenCashSessionResponseSchema = okDataSchema(
  operateOpenCashSessionDataSchema,
  "OperateOpenCashSessionResponse",
)

export const operateOpenSessionRoute = documentedRoute({
  method: "get",
  path: "/open-session",
  tags,
  summary: "Turno de caja abierto del usuario",
  description:
    "Sesión abierta por el usuario logueado, con punto ARCA si la caja lo tiene. Permiso `sale:read`, `mesas:read` o `mostrador:read`. No cae a turnos de otros.",
  middleware: [requireAnyPermission(OPERATE_OPEN_SESSION_READ)],
  success: operateOpenCashSessionResponseSchema,
  successDescription: "Turno propio abierto, o `session: null`.",
})
