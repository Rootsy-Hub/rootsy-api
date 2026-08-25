import { documentedRoute } from "../../openapi/documentedRoute.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  MOSTRADOR_CREATE,
  MOSTRADOR_READ,
  MOSTRADOR_UPDATE,
} from "./allowlist.js"
import {
  closeCounterOrderBodySchema,
  counterOrderCheckoutBodySchema,
  counterOrderStatusBodySchema,
  createCounterOrderBodySchema,
  patchCounterOrderBodySchema,
} from "./schema.js"

const tags = ["Mostrador"]
const read = [requireAnyPermission(MOSTRADOR_READ)] as const
const create = [requireMutationPermission(MOSTRADOR_CREATE)] as const
const update = [requireMutationPermission(MOSTRADOR_UPDATE)] as const

export const listCounterOrdersRoute = documentedRoute({
  method: "get",
  path: "/orders",
  tags,
  summary: "Listar pedidos de mostrador",
  description: "Permiso `mostrador:read`.",
  middleware: read,
})

export const createCounterOrderRoute = documentedRoute({
  method: "post",
  path: "/orders",
  tags,
  summary: "Crear pedido de mostrador",
  description: "Permiso `mostrador:create` (o aprobación).",
  middleware: create,
  body: createCounterOrderBodySchema,
})

export const getCounterOrderRoute = documentedRoute({
  method: "get",
  path: "/orders/{orderId}",
  tags,
  summary: "Obtener pedido",
  description: "Permiso `mostrador:read`.",
  middleware: read,
})

export const patchCounterOrderRoute = documentedRoute({
  method: "patch",
  path: "/orders/{orderId}",
  tags,
  summary: "Actualizar pedido",
  description: "PATCH parcial. Permiso `mostrador:update` (o aprobación).",
  middleware: update,
  body: patchCounterOrderBodySchema,
})

export const counterOrderStatusRoute = documentedRoute({
  method: "patch",
  path: "/orders/{orderId}/status",
  tags,
  summary: "Cambiar estado del pedido",
  description: "Permiso `mostrador:update` (o aprobación).",
  middleware: update,
  body: counterOrderStatusBodySchema,
})

export const counterOrderCheckoutRoute = documentedRoute({
  method: "patch",
  path: "/orders/{orderId}/checkout",
  tags,
  summary: "Guardar checkout",
  description: "Permiso `mostrador:update` (o aprobación).",
  middleware: update,
  body: counterOrderCheckoutBodySchema,
})

export const closeCounterOrderRoute = documentedRoute({
  method: "patch",
  path: "/orders/{orderId}/close",
  tags,
  summary: "Cerrar pedido",
  description: "`settle` o `release`. Permiso `mostrador:update` (o aprobación).",
  middleware: update,
  body: closeCounterOrderBodySchema,
})

export const cancelCounterOrderRoute = documentedRoute({
  method: "patch",
  path: "/orders/{orderId}/cancel",
  tags,
  summary: "Cancelar pedido",
  description: "Permiso `mostrador:update` (o aprobación).",
  middleware: update,
})
