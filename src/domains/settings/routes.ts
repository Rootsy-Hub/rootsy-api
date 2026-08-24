import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import { SETTINGS_READ, SETTINGS_UPDATE } from "./allowlist.js"
import { uploadSettingsImage } from "./image.js"
import {
  updateSettingsBusiness,
  updateSettingsFiscal,
  updateSettingsImages,
} from "./mutations.js"
import { getPopSettings } from "./queries.js"
import { parsePatchBody } from "../../lib/patchBody.js"
import {
  settingsImageKindSchema,
  updateBusinessBodySchema,
  updateFiscalBodySchema,
  updateImagesBodySchema,
} from "./schema.js"

export const settingsRoutes = new Hono<SidecarEnv>()

settingsRoutes.get("/", requireAnyPermission(SETTINGS_READ), async (c) => {
  const sidecar = c.get("sidecar")
  const result = await getPopSettings(
    c.get("supabase"),
    sidecar.popId,
    sidecar.isOwner,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

settingsRoutes.patch(
  "/business",
  requireMutationPermission(SETTINGS_UPDATE),
  async (c) => {
    const body = parsePatchBody(
      updateBusinessBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const result = await updateSettingsBusiness(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

settingsRoutes.patch(
  "/fiscal",
  requireMutationPermission(SETTINGS_UPDATE),
  async (c) => {
    const body = parsePatchBody(
      updateFiscalBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const result = await updateSettingsFiscal(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

settingsRoutes.patch(
  "/images",
  requireMutationPermission(SETTINGS_UPDATE),
  async (c) => {
    const body = parsePatchBody(
      updateImagesBodySchema,
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json({ success: false, error: body.error }, 400)
    }
    const result = await updateSettingsImages(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

settingsRoutes.post(
  "/image",
  requireAnyPermission(SETTINGS_UPDATE),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      return c.json({ success: false, error: "Elegí una imagen para subir." }, 400)
    }
    const kind = settingsImageKindSchema.safeParse(body.kind)
    if (!kind.success) {
      return c.json({ success: false, error: "Tipo de imagen inválido." }, 400)
    }
    const result = await uploadSettingsImage(
      c.get("supabase"),
      c.get("sidecar").popId,
      kind.data,
      file,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result, 201)
  },
)
