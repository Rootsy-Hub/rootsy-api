import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  ARTICLE_CREATE,
  ARTICLE_DELETE,
  ARTICLE_READ,
  ARTICLE_UPDATE,
} from "./allowlist.js"
import { uploadArticleImage } from "./image.js"
import { createArticle, deleteArticle, updateArticle } from "./mutations.js"
import { getArticle, listArticles } from "./queries.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  deleteArticleBodySchema,
  listArticlesQuerySchema,
  toListArticlesQuery,
  upsertArticleBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

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

export const articleRoutes = new Hono<SidecarEnv>()

articleRoutes.get("/", requireAnyPermission(ARTICLE_READ), async (c) => {
  const parsed = listArticlesQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    soloActivos: c.req.query("soloActivos") || undefined,
    soloInactivos: c.req.query("soloInactivos") || undefined,
    conDescuento: c.req.query("conDescuento") || undefined,
    sinDescuento: c.req.query("sinDescuento") || undefined,
    conStock: c.req.query("conStock") || undefined,
    sinStock: c.req.query("sinStock") || undefined,
    stockNegativo: c.req.query("stockNegativo") || undefined,
    ventaSinStock: c.req.query("ventaSinStock") || undefined,
    categoryId: c.req.query("categoryId") || undefined,
    itemKinds: c.req.query("itemKinds") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listArticles(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListArticlesQuery(parsed.data),
    articleCaps(c.get("sidecar")),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

articleRoutes.post("/", requireMutationPermission(ARTICLE_CREATE), async (c) => {
  const body = upsertArticleBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const sidecar = c.get("sidecar")
  const result = await createArticle(
    c.get("supabase"),
    sidecar.popId,
    sidecar.popSiteId,
    c.get("userId"),
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

articleRoutes.post(
  "/image",
  requireAnyPermission([...ARTICLE_CREATE, ...ARTICLE_UPDATE]),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      return c.json({ success: false, error: "Elegí una imagen para subir." }, 400)
    }
    const result = await uploadArticleImage(
      c.get("supabase"),
      c.get("sidecar").popId,
      file,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

articleRoutes.get("/:articleId", requireAnyPermission(ARTICLE_READ), async (c) => {
  const id = idSchema.safeParse(c.req.param("articleId"))
  if (!id.success) {
    return c.json({ success: false, error: "articleId inválido" }, 400)
  }
  const result = await getArticle(
    c.get("supabase"),
    c.get("sidecar").popId,
    id.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

articleRoutes.patch(
  "/:articleId",
  requireMutationPermission(ARTICLE_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("articleId"))
    if (!id.success) {
      return c.json({ success: false, error: "articleId inválido" }, 400)
    }
    const body = parsePatchBody(
      upsertArticleBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const sidecar = c.get("sidecar")
    const result = await updateArticle(
      c.get("supabase"),
      sidecar.popId,
      sidecar.popSiteId,
      id.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

articleRoutes.delete(
  "/:articleId",
  requireMutationPermission(ARTICLE_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("articleId"))
    if (!id.success) {
      return c.json({ success: false, error: "articleId inválido" }, 400)
    }
    const body = deleteArticleBodySchema.safeParse(
      await c.req.json().catch(() => ({ confirmationTyped: "" })),
    )
    if (!body.success) {
      return c.json(
        { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
        400,
      )
    }
    const result = await deleteArticle(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data.confirmationTyped,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
