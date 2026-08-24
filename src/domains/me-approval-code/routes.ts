import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"

export const meApprovalCodeRoutes = new Hono<SidecarEnv>()

const codeBodySchema = z.object({
  code: z.string(),
})

meApprovalCodeRoutes.get("/", async (c) => {
  const { data, error } = await c.get("supabase").rpc("rootsy_approval_code_status", {
    p_pop_id: c.get("sidecar").popId,
  })
  if (error) return c.json({ success: false, error: error.message }, 500)
  const payload = data as { ok?: boolean; can_set?: boolean; has_code?: boolean } | null
  if (!payload?.ok) {
    return c.json({ success: false, error: "Sin permiso" }, 403)
  }
  return c.json({
    success: true,
    data: {
      canSet: Boolean(payload.can_set),
      hasCode: Boolean(payload.has_code),
    },
  })
})

meApprovalCodeRoutes.put("/", async (c) => {
  const body = codeBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json({ success: false, error: "Código inválido." }, 400)
  }
  const { data, error } = await c.get("supabase").rpc("rootsy_set_approval_code", {
    p_pop_id: c.get("sidecar").popId,
    p_code: body.data.code.trim(),
  })
  if (error) return c.json({ success: false, error: error.message }, 500)
  const payload = data as { ok?: boolean; error?: string } | null
  if (!payload?.ok) {
    const err = payload?.error
    if (err === "code_taken") {
      return c.json(
        { success: false, error: "Ese código ya lo usa otra persona en este local." },
        409,
      )
    }
    if (err === "invalid_code") {
      return c.json(
        { success: false, error: "Usá un código de 4 a 8 dígitos." },
        400,
      )
    }
    return c.json({ success: false, error: "Sin permiso" }, 403)
  }
  return c.json({ success: true })
})

meApprovalCodeRoutes.delete("/", async (c) => {
  const { data, error } = await c.get("supabase").rpc("rootsy_clear_approval_code", {
    p_pop_id: c.get("sidecar").popId,
  })
  if (error) return c.json({ success: false, error: error.message }, 500)
  const payload = data as { ok?: boolean } | null
  if (!payload?.ok) return c.json({ success: false, error: "Sin permiso" }, 403)
  return c.json({ success: true })
})
