import { createRoute } from "@hono/zod-openapi"
import { jsonError, mutationHeadersSchema, popIdParamSchema } from "../../openapi/schemas.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  CLIENT_CREATE,
  CLIENT_DELETE,
  CLIENT_READ,
  CLIENT_UPDATE,
} from "./allowlist.js"
import {
  clientIdParamSchema,
  clientListResponseSchema,
  createClientResponseSchema,
  deleteClientBodySchema,
  listClientsQuerySchema,
  patchClientBodySchema,
  upsertClientBodySchema,
} from "./schema.js"
import { mutateOkResponseSchema } from "../../openapi/schemas.js"

const authSecurity = [{ ApiSecret: [], BearerAuth: [] }]

const authErrors = {
  401: jsonError("Falta secret o JWT."),
  403: jsonError("Sin permiso, o falta código de aprobación."),
} as const

export const listClientsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Clientes"],
  summary: "Listar clientes",
  description: "Paginado. Permiso `clients:read`.",
  security: authSecurity,
  middleware: [requireAnyPermission(CLIENT_READ)] as const,
  request: {
    params: popIdParamSchema,
    query: listClientsQuerySchema,
  },
  responses: {
    200: {
      description: "Listado paginado.",
      content: {
        "application/json": { schema: clientListResponseSchema },
      },
    },
    400: jsonError("Query inválida."),
    ...authErrors,
    500: jsonError("Error interno."),
  },
})

export const createClientRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Clientes"],
  summary: "Crear cliente",
  description: "Body completo. Permiso `clients:create` (o aprobación).",
  security: authSecurity,
  middleware: [requireMutationPermission(CLIENT_CREATE)] as const,
  request: {
    headers: mutationHeadersSchema,
    params: popIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: upsertClientBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Creado.",
      content: {
        "application/json": { schema: createClientResponseSchema },
      },
    },
    400: jsonError("Body inválido."),
    ...authErrors,
    404: jsonError("No se encontró el cliente."),
    500: jsonError("Error interno."),
  },
})

export const patchClientRoute = createRoute({
  method: "patch",
  path: "/{clientId}",
  tags: ["Clientes"],
  summary: "Actualizar cliente",
  description:
    "PATCH parcial: solo los campos enviados. Permiso `clients:update` (o aprobación).",
  security: authSecurity,
  middleware: [requireMutationPermission(CLIENT_UPDATE)] as const,
  request: {
    headers: mutationHeadersSchema,
    params: clientIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: patchClientBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Actualizado.",
      content: {
        "application/json": { schema: mutateOkResponseSchema },
      },
    },
    400: jsonError("Body o clientId inválido."),
    ...authErrors,
    404: jsonError("No se encontró el cliente."),
    500: jsonError("Error interno."),
  },
})

export const deleteClientRoute = createRoute({
  method: "delete",
  path: "/{clientId}",
  tags: ["Clientes"],
  summary: "Eliminar cliente",
  description:
    'Hay que mandar `confirmationTyped` igual a "Eliminar {nombre}". Permiso `clients:delete` (o aprobación).',
  security: authSecurity,
  middleware: [requireMutationPermission(CLIENT_DELETE)] as const,
  request: {
    headers: mutationHeadersSchema,
    params: clientIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: deleteClientBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Eliminado.",
      content: {
        "application/json": { schema: mutateOkResponseSchema },
      },
    },
    400: jsonError("Confirmación o clientId inválido."),
    ...authErrors,
    404: jsonError("No se encontró el cliente."),
    500: jsonError("Error interno."),
  },
})
