import type { SupabaseClient } from "@supabase/supabase-js"
import { Hono } from "hono"
import { z } from "zod"
import { redactAuditJson } from "../../audit/types.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"

const AUDIT_READ = ["audit:read"] as const

type AuditEventRow = {
  id: string
  occurred_at: string
  expires_at: string
  resource: string
  resource_id: string | null
  action: string
  http_method: string
  path: string
  previous_state: unknown
  new_state: unknown
  requester_user_id: string | null
  approver_user_id: string | null
  execution_source: string
  kind: string | null
}

function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

function csvAllowlist(
  raw: string | undefined,
  allow: readonly string[],
): string[] {
  if (!raw?.trim()) return []
  const allowSet = new Set(allow)
  return [
    ...new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => allowSet.has(item)),
    ),
  ]
}

function buildAuditSearchOr(raw: string | undefined): string | null {
  const t = raw?.trim().replace(/,/g, " ").trim()
  if (!t) return null
  const pattern = `%${escapeIlikeToken(t)}%`
  return [
    `resource.ilike.${pattern}`,
    `path.ilike.${pattern}`,
    `kind.ilike.${pattern}`,
    `new_state->>name.ilike.${pattern}`,
    `previous_state->>name.ilike.${pattern}`,
    `new_state->>description.ilike.${pattern}`,
    `previous_state->>description.ilike.${pattern}`,
    `new_state->>first_name.ilike.${pattern}`,
    `previous_state->>first_name.ilike.${pattern}`,
    `new_state->>email.ilike.${pattern}`,
    `previous_state->>email.ilike.${pattern}`,
  ].join(",")
}

function personName(row: {
  first_name?: string | null
  last_name?: string | null
}): string {
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()
}

/** Empleado del POP primero (nombre de RRHH); si no hay ficha, la cuenta. */
async function namesByUserId(
  supabase: SupabaseClient,
  popId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, string>()
  if (unique.length === 0) return map

  const [{ data: employees }, { data: profiles }] = await Promise.all([
    supabase
      .from("pop_employees")
      .select("user_id, first_name, last_name, left_at")
      .eq("pop_id", popId)
      .in("user_id", unique),
    supabase.from("users").select("id, first_name, last_name").in("id", unique),
  ])

  for (const profile of profiles ?? []) {
    const name = personName(profile)
    if (name) map.set(String(profile.id), name)
  }

  const employeeRows = new Map<
    string,
    { first_name: string; last_name: string; left_at: string | null }[]
  >()
  for (const employee of employees ?? []) {
    if (!employee.user_id) continue
    const id = String(employee.user_id)
    const rows = employeeRows.get(id) ?? []
    rows.push({
      first_name: employee.first_name ?? "",
      last_name: employee.last_name ?? "",
      left_at: employee.left_at ?? null,
    })
    employeeRows.set(id, rows)
  }

  for (const [id, rows] of employeeRows) {
    const ranked = [...rows].sort((a, b) => Number(Boolean(a.left_at)) - Number(Boolean(b.left_at)))
    for (const row of ranked) {
      const name = personName(row)
      if (!name) continue
      map.set(id, name)
      break
    }
  }

  return map
}

const RESOURCE_NAME_LOOKUP: Record<string, { table: string; column: string }> = {
  articles: { table: "articles", column: "name" },
  categories: { table: "categories", column: "name" },
  checks: { table: "checks", column: "check_number" },
  clients: { table: "clients", column: "name" },
  expenses: { table: "expenses", column: "description" },
  "expense-categories": { table: "expense_categories", column: "name" },
  printers: { table: "pop_printers", column: "name" },
  "price-lists": { table: "price_lists", column: "name" },
  promotions: { table: "promotions", column: "name" },
  recipes: { table: "recipes", column: "name" },
  "recipe-categories": { table: "recipe_categories", column: "name" },
  services: { table: "service_types", column: "name" },
  "service-categories": { table: "service_categories", column: "name" },
  suppliers: { table: "suppliers", column: "name" },
}

function recordKey(resource: string, id: string): string {
  return `${resource}:${id}`
}

async function recordLabelsById(
  supabase: SupabaseClient,
  popId: string,
  rows: AuditEventRow[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const idsByResource = new Map<string, string[]>()
  const employeeIds: string[] = []
  const inviteIds: string[] = []

  for (const row of rows) {
    if (!row.resource_id) continue
    if (row.resource === "hr") {
      if (row.kind?.startsWith("hr.employee.")) employeeIds.push(row.resource_id)
      else if (row.kind?.startsWith("hr.invitation.")) inviteIds.push(row.resource_id)
      continue
    }
    if (!RESOURCE_NAME_LOOKUP[row.resource]) continue
    const list = idsByResource.get(row.resource) ?? []
    list.push(row.resource_id)
    idsByResource.set(row.resource, list)
  }

  const jobs: Promise<void>[] = []

  for (const [resource, ids] of idsByResource) {
    const spec = RESOURCE_NAME_LOOKUP[resource]
    const unique = [...new Set(ids)]
    jobs.push(
      (async () => {
        const { data, error } = await supabase
          .from(spec.table)
          .select(`id, ${spec.column}`)
          .eq("pop_id", popId)
          .in("id", unique)
        if (error) return
        for (const row of (data as unknown as Record<string, unknown>[] | null) ?? []) {
          const label = String(row[spec.column] ?? "").trim()
          if (label) map.set(recordKey(resource, String(row.id)), label)
        }
      })(),
    )
  }

  const uniqueEmployees = [...new Set(employeeIds)]
  if (uniqueEmployees.length > 0) {
    jobs.push(
      (async () => {
        const { data, error } = await supabase
          .from("pop_employees")
          .select("id, first_name, last_name")
          .eq("pop_id", popId)
          .in("id", uniqueEmployees)
        if (error) return
        for (const row of data ?? []) {
          const name = personName(row)
          if (name) map.set(recordKey("hr", String(row.id)), name)
        }
      })(),
    )
  }

  const uniqueInvites = [...new Set(inviteIds)]
  if (uniqueInvites.length > 0) {
    jobs.push(
      (async () => {
        const { data, error } = await supabase
          .from("pop_invitations")
          .select("id, email")
          .eq("pop_id", popId)
          .in("id", uniqueInvites)
        if (error) return
        for (const row of data ?? []) {
          const email = String(row.email ?? "").trim()
          if (email) map.set(recordKey("hr", String(row.id)), email)
        }
      })(),
    )
  }

  await Promise.all(jobs)
  return map
}

export const auditRoutes = new Hono<SidecarEnv>()

auditRoutes.get("/", requireAnyPermission(AUDIT_READ), async (c) => {
  const parsed = z
    .object({
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(50).optional(),
      resource: z.string().optional(),
      q: z.string().max(80).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      action: z.string().optional(),
      source: z.string().optional(),
    })
    .safeParse({
      page: c.req.query("page") || undefined,
      pageSize: c.req.query("pageSize") || undefined,
      resource: c.req.query("resource") || undefined,
      q: c.req.query("q") || undefined,
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
      action: c.req.query("action") || undefined,
      source: c.req.query("source") || undefined,
    })
  if (!parsed.success) {
    return c.json({ success: false, error: "Parámetros inválidos" }, 400)
  }

  const page = parsed.data.page ?? 1
  const pageSize = parsed.data.pageSize ?? 20
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  const popId = c.get("sidecar").popId
  const supabase = c.get("supabase")

  const ACTIONS = ["create", "update", "delete"] as const
  const SOURCES = ["user", "rootsy_ai", "system"] as const

  const actions = csvAllowlist(parsed.data.action, ACTIONS)
  const sources = csvAllowlist(parsed.data.source, SOURCES)

  let query = supabase
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

  if (parsed.data.from) {
    query = query.gte("occurred_at", `${parsed.data.from}T00:00:00.000`)
  }
  if (parsed.data.to) {
    query = query.lte("occurred_at", `${parsed.data.to}T23:59:59.999`)
  }
  if (actions.length > 0 && actions.length < ACTIONS.length) {
    query = query.in("action", actions)
  }
  if (sources.length > 0 && sources.length < SOURCES.length) {
    query = query.in("execution_source", sources)
  }

  const searchOr = buildAuditSearchOr(parsed.data.q)
  if (searchOr) query = query.or(searchOr)

  const { data, error, count } = await query
  if (error) {
    return c.json({ success: false, error: error.message }, 500)
  }

  const rows = (data ?? []) as AuditEventRow[]
  const actorIds = rows.flatMap((row) =>
    [row.requester_user_id, row.approver_user_id].filter((id): id is string => Boolean(id)),
  )
  const [names, recordLabels] = await Promise.all([
    namesByUserId(supabase, popId, actorIds),
    recordLabelsById(supabase, popId, rows),
  ])

  const events = rows.map((row) => ({
    ...row,
    previous_state: redactAuditJson(row.previous_state),
    new_state: redactAuditJson(row.new_state),
    requester_name: row.requester_user_id
      ? names.get(row.requester_user_id) ?? null
      : null,
    approver_name: row.approver_user_id
      ? names.get(row.approver_user_id) ?? null
      : null,
    record_label:
      row.resource_id
        ? recordLabels.get(recordKey(row.resource, row.resource_id)) ?? null
        : null,
  }))

  return c.json({
    success: true,
    data: {
      events,
      page,
      pageSize,
      total: count ?? 0,
    },
  })
})
