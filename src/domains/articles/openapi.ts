import { createRoute, z } from "@hono/zod-openapi"
import { documentedRoute } from "../../openapi/documentedRoute.js"
import {
  authSecurity,
  jsonError,
  popIdParamSchema,
} from "../../openapi/schemas.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import {
  ARTICLE_CREATE,
  ARTICLE_DELETE,
  ARTICLE_LIST_READ,
  ARTICLE_READ,
  ARTICLE_UPDATE,
} from "./allowlist.js"
import {
  articleImageResponseSchema,
  articleListResponseSchema,
  articleResponseSchema,
  deleteArticleBodySchema,
  listArticlesQuerySchema,
  patchArticleBodySchema,
  upsertArticleBodySchema,
} from "./schema.js"

const tags = ["Artículos"]
const listRead = [requireAnyPermission(ARTICLE_LIST_READ)] as const
const read = [requireAnyPermission(ARTICLE_READ)] as const
const create = [requireMutationPermission(ARTICLE_CREATE)] as const
const update = [requireMutationPermission(ARTICLE_UPDATE)] as const
const remove = [requireMutationPermission(ARTICLE_DELETE)] as const

export const listArticlesRoute = documentedRoute({
  method: "get",
  path: "/",
  tags,
  summary: "Listar artículos",
  description:
    "Paginado y filtros. Permiso `articles:read`, `sale:read`, `mesas:read` o `mostrador:read`.",
  middleware: listRead,
  query: listArticlesQuerySchema,
  success: articleListResponseSchema,
  successDescription: "Listado paginado.",
})

export const createArticleRoute = documentedRoute({
  method: "post",
  path: "/",
  tags,
  summary: "Crear artículo",
  description: "Body completo. Permiso `articles:create` (o aprobación).",
  middleware: create,
  body: upsertArticleBodySchema,
})

export const uploadArticleImageRoute = createRoute({
  method: "post",
  path: "/image",
  tags,
  summary: "Subir imagen de artículo",
  description:
    "multipart/form-data, campo `file` (WebP, máx. 5 MB). Permiso `articles:create` o `articles:update`. No usa código de aprobación.",
  security: [...authSecurity],
  middleware: [
    requireAnyPermission([...ARTICLE_CREATE, ...ARTICLE_UPDATE]),
  ] as const,
  request: {
    params: popIdParamSchema,
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: z
            .object({
              file: z
                .custom<File>((val) => val instanceof File, {
                  message: "Elegí una imagen para subir.",
                })
                .openapi({
                  type: "string",
                  format: "binary",
                  description: "Imagen WebP, máximo 5 MB.",
                }),
            })
            .openapi("UploadArticleImageForm"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "URL pública de la imagen.",
      content: {
        "application/json": { schema: articleImageResponseSchema },
      },
    },
    400: jsonError("Archivo inválido."),
    401: jsonError("Falta secret o JWT."),
    403: jsonError("Sin permiso."),
    500: jsonError("Error interno."),
  },
})

export const getArticleRoute = documentedRoute({
  method: "get",
  path: "/{articleId}",
  tags,
  summary: "Obtener artículo",
  description: "Permiso `articles:read`.",
  middleware: read,
  success: articleResponseSchema,
  successDescription: "Artículo con costos y listas de precio.",
})

export const patchArticleRoute = documentedRoute({
  method: "patch",
  path: "/{articleId}",
  tags,
  summary: "Actualizar artículo",
  description:
    "PATCH parcial: solo los campos enviados. Permiso `articles:update` (o aprobación).",
  middleware: update,
  body: patchArticleBodySchema,
})

export const deleteArticleRoute = documentedRoute({
  method: "delete",
  path: "/{articleId}",
  tags,
  summary: "Eliminar artículo",
  description:
    'Hay que mandar `confirmationTyped` igual a "Eliminar {nombre}". Permiso `articles:delete` (o aprobación).',
  middleware: remove,
  body: deleteArticleBodySchema,
})
