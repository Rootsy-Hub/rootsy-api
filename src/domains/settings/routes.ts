import { Hono } from "hono"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { SETTINGS_READ, SETTINGS_UPDATE } from "./allowlist.js"
import { uploadSettingsImage } from "./image.js"
import {
  updateSettingsBusiness,
  updateSettingsFiscal,
  updateSettingsImages,
} from "./mutations.js"
import { getPopSettings } from "./queries.js"
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
  requireAnyPermission(SETTINGS_UPDATE),
  async (c) => {
    const body = updateBusinessBodySchema.safeParse(
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
    const result = await updateSettingsBusiness(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

settingsRoutes.patch(
  "/fiscal",
  requireAnyPermission(SETTINGS_UPDATE),
  async (c) => {
    const body = updateFiscalBodySchema.safeParse(
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
    const result = await updateSettingsFiscal(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

settingsRoutes.patch(
  "/images",
  requireAnyPermission(SETTINGS_UPDATE),
  async (c) => {
    const body = updateImagesBodySchema.safeParse(
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
    const result = await updateSettingsImages(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data,
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
