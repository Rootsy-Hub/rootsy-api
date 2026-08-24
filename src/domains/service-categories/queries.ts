import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import type { ServiceCategoryRow } from "./schema.js"

const SELECT = "id, pop_id, name, kind, sort_order, deleted_at, created_at"

type ServiceCategoryDbRow = {
  id: string
  pop_id: string
  name: string
  kind: string
  sort_order: number
  deleted_at: string | null
  created_at: string
}

function mapRow(row: ServiceCategoryDbRow): ServiceCategoryRow {
  return {
    id: row.id,
    popId: row.pop_id,
    name: row.name,
    kind: row.kind === "fijo" ? "fijo" : "variable",
    sortOrder: row.sort_order ?? 0,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  }
}

async function nextSortOrder(
  supabase: SupabaseClient,
  popId: string,
): Promise<number> {
  const { data: maxRow } = await supabase
    .from("service_categories")
    .select("sort_order")
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle()
  return maxRow?.sort_order != null ? Number(maxRow.sort_order) + 1 : 0
}

export async function listServiceCategories(
  supabase: SupabaseClient,
  popId: string,
  filters: {
    kind?: ServiceCategoryRow["kind"]
    includeDeleted?: boolean
  },
): Promise<
  { success: true; data: ServiceCategoryRow[] } | { success: false; error: string }
> {
  let q = supabase
    .from("service_categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .order("sort_order")
    .order("name")

  if (!filters.includeDeleted) q = q.is("deleted_at", null)
  if (filters.kind) q = q.eq("kind", filters.kind)

  const { data, error } = await q
  if (error) return { success: false, error: error.message }
  return {
    success: true,
    data: (data ?? []).map((row) => mapRow(row as ServiceCategoryDbRow)),
  }
}

export async function getServiceCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<
  | { success: true; data: ServiceCategoryRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("service_categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("id", categoryId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }
  return { success: true, data: mapRow(data as ServiceCategoryDbRow) }
}

export async function createServiceCategory(
  supabase: SupabaseClient,
  popId: string,
  input: {
    name: string
    kind: ServiceCategoryRow["kind"]
    sortOrder?: number
  },
  audit: MutationAuditCtx,
): Promise<
  { success: true; data: ServiceCategoryRow } | { success: false; error: string }
> {
  const sortOrder = input.sortOrder ?? (await nextSortOrder(supabase, popId))
  const id = randomUUID()
  const now = new Date().toISOString()
  const row: ServiceCategoryDbRow = {
    id,
    pop_id: popId,
    name: input.name,
    kind: input.kind,
    sort_order: sortOrder,
    deleted_at: null,
    created_at: now,
  }
  const applied = await auditedInsert(supabase, {
    kind: "service-categories.create",
    table: "service_categories",
    row: {
      id,
      pop_id: popId,
      name: input.name,
      kind: input.kind,
      sort_order: sortOrder,
    },
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error || "No se pudo crear." }
  }
  return { success: true, data: mapRow(row) }
}

export async function updateServiceCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
  input: {
    name?: string
    kind?: ServiceCategoryRow["kind"]
    sortOrder?: number
  },
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: ServiceCategoryRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: current, error: fetchError } = await supabase
    .from("service_categories")
    .select(SELECT)
    .eq("id", categoryId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
  if (fetchError) {
    return { success: false, error: fetchError.message, status: 500 }
  }
  if (!current) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }

  const patch: Record<string, unknown> = {}
  if (input.name != null) patch.name = input.name
  if (input.kind != null) patch.kind = input.kind
  if (input.sortOrder != null) patch.sort_order = input.sortOrder

  const next = { ...current, ...patch }
  const applied = await auditedUpdate(supabase, {
    kind: "service-categories.patch",
    table: "service_categories",
    id: categoryId,
    row: patch,
    ctx: audit,
    popId,
    previous: current,
    next,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status === 404 ? 404 : 500,
    }
  }
  return { success: true, data: mapRow(next as ServiceCategoryDbRow) }
}

export async function deleteServiceCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
  audit: MutationAuditCtx,
): Promise<
  { success: true } | { success: false; error: string; status: 404 | 409 | 500 }
> {
  const existing = await getServiceCategory(supabase, popId, categoryId)
  if (!existing.success) return existing
  if (existing.data.deletedAt) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }

  const { count, error: countError } = await supabase
    .from("service_types")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("category_id", categoryId)

  if (countError) {
    return { success: false, error: countError.message, status: 500 }
  }
  if ((count ?? 0) > 0) {
    return {
      success: false,
      status: 409,
      error: `No se puede eliminar "${existing.data.name}": tiene ${count} servicio(s).`,
    }
  }

  const deletedAt = new Date().toISOString()
  const applied = await auditedUpdate(supabase, {
    kind: "service-categories.delete",
    table: "service_categories",
    id: categoryId,
    row: { deleted_at: deletedAt },
    ctx: audit,
    popId,
    previous: existing.data,
    next: null,
  })
  if (!applied.success) {
    return {
      success: false,
      error: applied.error,
      status: applied.status === 404 ? 404 : 500,
    }
  }
  return { success: true }
}
