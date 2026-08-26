import type { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { createOpenApiApp } from "../../openapi/app.js"
import { apiFail } from "../../openapi/respond.js"
import { routeInput, routeParam } from "../../openapi/valid.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import { uploadArticleImage } from "./image.js"
import { createArticle, deleteArticle, updateArticle } from "./mutations.js"
import { getArticle, listArticles } from "./queries.js"
import {
  articleRealtimeSnapshot,
  publishArticleEventBestEffort,
} from "./realtime.js"
import {
  createArticleRoute,
  deleteArticleRoute,
  getArticleRoute,
  listArticlesRoute,
  patchArticleRoute,
  uploadArticleImageRoute,
} from "./openapi.js"
import {
  listArticlesQuerySchema,
  toListArticlesQuery,
  upsertArticleBodySchema,
} from "./schema.js"

function articleCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`articles:${action}`)
  const canCreate = can("create")
  return {
    canCreate,
    canPostInitialStock: canCreate,
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

export const articleRoutes = createOpenApiApp<SidecarEnv>()

articleRoutes.openapi(listArticlesRoute, async (c) => {
  const result = await listArticles(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListArticlesQuery(
      routeInput<z.infer<typeof listArticlesQuerySchema>>(c, "query"),
    ),
    articleCaps(c.get("sidecar")),
  )
  if (!result.success) return apiFail(c, result.error, 500)
  return c.json(result, 200)
})

articleRoutes.openapi(createArticleRoute, async (c) => {
  const sidecar = c.get("sidecar")
  const result = await createArticle(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    c.get("userId"),
    routeInput<z.infer<typeof upsertArticleBodySchema>>(c, "json"),
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  if (result.articleId) {
    const row = await getArticle(c.get("supabase"), sidecar.popId, result.articleId)
    if (row.success) {
      await publishArticleEventBestEffort(c, {
        type: "articles.created",
        articleId: result.articleId,
        payload: { article: articleRealtimeSnapshot(row.data) },
      })
    }
  }
  return c.json({ success: true as const }, 201)
})

articleRoutes.openapi(uploadArticleImageRoute, async (c) => {
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File)) {
    return apiFail(c, "Elegí una imagen para subir.", 400)
  }
  const result = await uploadArticleImage(
    c.get("supabase"),
    c.get("sidecar").popId,
    file,
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json(result, 201)
})

articleRoutes.openapi(getArticleRoute, async (c) => {
  const result = await getArticle(
    c.get("supabase"),
    c.get("sidecar").popId,
    routeParam(c, "articleId"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  return c.json(result, 200)
})

articleRoutes.openapi(patchArticleRoute, async (c) => {
  const body = parsePatchBody(
    upsertArticleBodySchema,
    await c.req.json().catch(() => null),
  )
  if (!body.success) return apiFail(c, body.error, 400)
  const sidecar = c.get("sidecar")
  const articleId = routeParam(c, "articleId")
  const result = await updateArticle(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    articleId,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  const row = await getArticle(c.get("supabase"), sidecar.popId, articleId)
  if (row.success) {
    await publishArticleEventBestEffort(c, {
      type: "articles.updated",
      articleId,
      payload: { article: articleRealtimeSnapshot(row.data) },
    })
  }
  return c.json({ success: true as const }, 200)
})

articleRoutes.openapi(deleteArticleRoute, async (c) => {
  const articleId = routeParam(c, "articleId")
  const result = await deleteArticle(
    c.get("supabase"),
    c.get("sidecar").popId,
    articleId,
    routeInput<{ confirmationTyped: string }>(c, "json").confirmationTyped,
    c.get("mutationAudit"),
  )
  if (!result.success) return apiFail(c, result.error, result.status)
  await publishArticleEventBestEffort(c, {
    type: "articles.deleted",
    articleId,
    payload: { articleId },
  })
  return c.json({ success: true as const }, 200)
})
