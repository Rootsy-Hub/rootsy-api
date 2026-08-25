import { createRoute, z } from "@hono/zod-openapi"
import type { MiddlewareHandler } from "hono"
import {
  apiOkResponseSchema,
  authSecurity,
  jsonError,
  mutateOkResponseSchema,
  mutationHeadersSchema,
  popIdParamSchema,
} from "./schemas.js"

type Method = "get" | "post" | "put" | "patch" | "delete"

function paramsForPath(path: string) {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "")
  const shape: Record<string, z.ZodType> = {
    popId: popIdParamSchema.shape.popId,
  }
  for (const name of names) {
    if (!name || name === "popId") continue
    shape[name] = z.string().uuid().openapi({
      param: { name, in: "path" },
    })
  }
  return z.object(shape)
}

export function documentedRoute<
  TQuery extends z.ZodObject<z.ZodRawShape> | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TSuccess extends z.ZodType | undefined = undefined,
>(opts: {
  method: Method
  path: string
  tags: string[]
  summary: string
  description?: string
  middleware: readonly MiddlewareHandler[]
  query?: TQuery
  body?: TBody
  bodyRequired?: boolean
  success?: TSuccess
  successStatus?: 200 | 201
  successDescription?: string
}) {
  const mutation = opts.method !== "get"
  const successStatus =
    opts.successStatus ?? (opts.method === "post" ? 201 : 200)
  const successSchema =
    opts.success ?? (mutation ? mutateOkResponseSchema : apiOkResponseSchema)
  const hasResourceParam = [...opts.path.matchAll(/\{([^}]+)\}/g)].some(
    (m) => m[1] && m[1] !== "popId",
  )

  return createRoute({
    method: opts.method,
    path: opts.path,
    tags: opts.tags,
    summary: opts.summary,
    description: opts.description,
    security: [...authSecurity],
    middleware: [...opts.middleware],
    request: {
      params: paramsForPath(opts.path),
      ...(opts.query ? { query: opts.query } : {}),
      ...(mutation ? { headers: mutationHeadersSchema } : {}),
      ...(opts.body
        ? {
            body: {
              required: opts.bodyRequired ?? true,
              content: {
                "application/json": { schema: opts.body },
              },
            },
          }
        : {}),
    },
    responses: {
      [successStatus]: {
        description:
          opts.successDescription ??
          (successStatus === 201 ? "Creado." : "OK"),
        content: { "application/json": { schema: successSchema } },
      },
      400: jsonError("Pedido inválido."),
      401: jsonError("Falta secret o JWT."),
      403: jsonError("Sin permiso, o falta código de aprobación."),
      ...(mutation || hasResourceParam
        ? {
            404: jsonError("No se encontró el recurso."),
          }
        : {}),
      ...(mutation
        ? {
            409: jsonError("Conflicto."),
          }
        : {}),
      500: jsonError("Error interno."),
    },
  })
}
