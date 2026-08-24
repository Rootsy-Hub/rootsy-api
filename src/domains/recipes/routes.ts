import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  RECIPE_CREATE,
  RECIPE_DELETE,
  RECIPE_READ,
  RECIPE_UPDATE,
} from "./allowlist.js"
import { uploadRecipeImage } from "./image.js"
import { createRecipe, deleteRecipe, updateRecipe } from "./mutations.js"
import {
  getRecipe,
  getRecipeIngredientsByIds,
  listRecipes,
  searchRecipeIngredients,
} from "./queries.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  deleteRecipeBodySchema,
  listRecipeIngredientsQuerySchema,
  listRecipesQuerySchema,
  toListRecipesQuery,
  upsertRecipeBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

function recipeCaps(sidecar: { keys: string[]; isOwner: boolean }) {
  const can = (action: string) =>
    sidecar.isOwner || sidecar.keys.includes(`recipes:${action}`)
  return {
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
  }
}

export const recipeRoutes = new Hono<SidecarEnv>()

recipeRoutes.get("/", requireAnyPermission(RECIPE_READ), async (c) => {
  const parsed = listRecipesQuerySchema.safeParse({
    page: c.req.query("page") || undefined,
    pageSize: c.req.query("pageSize") || undefined,
    q: c.req.query("q") || undefined,
    soloActivos: c.req.query("soloActivos") || undefined,
    categoryId: c.req.query("categoryId") || undefined,
    sort: c.req.query("sort") || undefined,
    ord: c.req.query("ord") || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const result = await listRecipes(
    c.get("supabase"),
    c.get("sidecar").popId,
    toListRecipesQuery(parsed.data),
    recipeCaps(c.get("sidecar")),
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

recipeRoutes.post("/", requireMutationPermission(RECIPE_CREATE), async (c) => {
  const body = upsertRecipeBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
      400,
    )
  }
  const result = await createRecipe(
    c.get("supabase"),
    c.get("sidecar").popId,
    body.data,
    c.get("mutationAudit"),
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result, 201)
})

recipeRoutes.post(
  "/image",
  requireAnyPermission([...RECIPE_CREATE, ...RECIPE_UPDATE]),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      return c.json({ success: false, error: "Elegí una imagen para subir." }, 400)
    }
    const result = await uploadRecipeImage(
      c.get("supabase"),
      c.get("sidecar").popId,
      file,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)

recipeRoutes.get(
  "/ingredients",
  requireAnyPermission(RECIPE_READ),
  async (c) => {
    const parsed = listRecipeIngredientsQuerySchema.safeParse({
      q: c.req.query("q") || undefined,
      ids: c.req.query("ids") || undefined,
      exclude: c.req.query("exclude") || undefined,
    })
    if (!parsed.success) {
      return c.json({ success: false, error: "Parámetros inválidos" }, 400)
    }

    const ids = parsed.data.ids
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
    const exclude = parsed.data.exclude
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)

    const result =
      ids.length > 0
        ? await getRecipeIngredientsByIds(
            c.get("supabase"),
            c.get("sidecar").popId,
            ids,
          )
        : await searchRecipeIngredients(
            c.get("supabase"),
            c.get("sidecar").popId,
            parsed.data.q,
            exclude,
          )
    if (!result.success) return c.json(result, 500)
    return c.json(result)
  },
)

recipeRoutes.get("/:recipeId", requireAnyPermission(RECIPE_READ), async (c) => {
  const id = idSchema.safeParse(c.req.param("recipeId"))
  if (!id.success) {
    return c.json({ success: false, error: "recipeId inválido" }, 400)
  }
  const result = await getRecipe(
    c.get("supabase"),
    c.get("sidecar").popId,
    id.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

recipeRoutes.patch(
  "/:recipeId",
  requireMutationPermission(RECIPE_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("recipeId"))
    if (!id.success) {
      return c.json({ success: false, error: "recipeId inválido" }, 400)
    }
    const body = parsePatchBody(
      upsertRecipeBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const result = await updateRecipe(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

recipeRoutes.delete(
  "/:recipeId",
  requireMutationPermission(RECIPE_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("recipeId"))
    if (!id.success) {
      return c.json({ success: false, error: "recipeId inválido" }, 400)
    }
    const body = deleteRecipeBodySchema.safeParse(
      await c.req.json().catch(() => ({ confirmationTyped: "" })),
    )
    if (!body.success) {
      return c.json(
        { success: false, error: body.error.issues[0]?.message ?? "Body inválido" },
        400,
      )
    }
    const result = await deleteRecipe(
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
