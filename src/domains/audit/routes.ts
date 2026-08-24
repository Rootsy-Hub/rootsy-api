import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"

const AUDIT_READ = ["audit:read"] as const

export const auditRoutes = new Hono<SidecarEnv>()

auditRoutes.get("/", requireAnyPermission(AUDIT_READ), async (c) => {
  const parsed = z
    .object({
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(50).optional(),
      resource: z.string().optional(),
    })
    .safeParse({
      page: c.req.query("page") || undefined,
      pageSize: c.req.query("pageSize") || undefined,
      resource: c.req.query("resource") || undefined,
    })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const page = parsed.data.page ?? 1
  const pageSize = parsed.data.pageSize ?? 20
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  const popId = c.get("sidecar").popId

  let query = c
    .get("supabase")
    .from("audit_events")
    .select(
      "id, occurred_at, expires_at, resource, resource_id, action, http_method, path, previous_state, new_state, requester_user_id, approver_user_id, execution_source, kind",
      { count: "exact" },
    )
    .eq("pop_id", popId)
    .gt("expires_at", new Date().toISOString())
    .order("occurred_at", { ascending: false })
    .range(from, to)

  const resource = parsed.data.resource?.trim()
  if (resource) query = query.eq("resource", resource)

  const { data, error, count } = await query
  if (error) {
    return c.json({ success: false, error: error.message }, 500)
  }

  return c.json({
    success: true,
    data: {
      events: data ?? [],
      page,
      pageSize,
      total: count ?? 0,
    },
  })
})
