import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import {
  auditedDelete,
  auditedInsert,
  auditedUpdate,
} from "../../audit/simpleWrite.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import type { CategoryRow } from "./schema.js"

const SELECT =
  "id, pop_id, name, item_kind, visible, show_in_sale, show_in_menu, sort_order, created_at, updated_at"

type CategoryDbRow = {
  id: string
  pop_id: string
  name: string
  item_kind: string
  visible: boolean
  show_in_sale: boolean
  show_in_menu: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

function mapRow(row: CategoryDbRow): CategoryRow {
  return {
    id: row.id,
    popId: row.pop_id,
    name: row.name,
    itemKind: row.item_kind as CategoryRow["itemKind"],
    visible: Boolean(row.visible),
    showInSale: Boolean(row.show_in_sale),
    showInMenu: Boolean(row.show_in_menu),
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listCategories(
  supabase: SupabaseClient,
  popId: string,
  filters: {
    itemKind?: CategoryRow["itemKind"]
    showInSale?: boolean
    showInMenu?: boolean
    visible?: boolean
  },
): Promise<{ success: true; data: CategoryRow[] } | { success: false; error: string }> {
  let q = supabase
    .from("categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .order("sort_order")
    .order("name")

  if (filters.itemKind) q = q.eq("item_kind", filters.itemKind)
  if (filters.showInSale != null) q = q.eq("show_in_sale", filters.showInSale)
  if (filters.showInMenu != null) q = q.eq("show_in_menu", filters.showInMenu)
  if (filters.visible != null) q = q.eq("visible", filters.visible)

  const { data, error } = await q
  if (error) return { success: false, error: error.message }
  return { success: true, data: (data ?? []).map((row) => mapRow(row as CategoryDbRow)) }
}

export type CategoryDetail = CategoryRow & { articleCount: number }

export async function getCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
): Promise<
  | { success: true; data: CategoryDetail }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data, error } = await supabase
    .from("categories")
    .select(SELECT)
    .eq("pop_id", popId)
    .eq("id", categoryId)
    .maybeSingle()

  if (error) return { success: false, error: error.message, status: 500 }
  if (!data) return { success: false, error: "Categoría no encontrada", status: 404 }

  const { count, error: countError } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("category_id", categoryId)

  if (countError) return { success: false, error: countError.message, status: 500 }

  return {
    success: true,
    data: { ...mapRow(data as CategoryDbRow), articleCount: count ?? 0 },
  }
}

export async function createCategory(
  supabase: SupabaseClient,
  popId: string,
  input: {
    name: string
    itemKind: CategoryRow["itemKind"]
    visible?: boolean
    showInSale?: boolean
    showInMenu?: boolean
    sortOrder?: number
  },
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: CategoryRow }
  | { success: false; error: string }
> {
  let sortOrder = input.sortOrder
  if (sortOrder == null) {
    const { data: maxRow } = await supabase
      .from("categories")
      .select("sort_order")
      .eq("pop_id", popId)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle()
    sortOrder =
      maxRow?.sort_order != null ? Number(maxRow.sort_order) + 1 : 0
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  const row: CategoryDbRow = {
    id,
    pop_id: popId,
    name: input.name,
    item_kind: input.itemKind,
    sort_order: sortOrder,
    visible: input.visible ?? true,
    show_in_sale: input.showInSale ?? true,
    show_in_menu: input.showInMenu ?? true,
    created_at: now,
    updated_at: now,
  }
  const applied = await auditedInsert(supabase, {
    kind: "categories.create",
    table: "categories",
    row: { ...row },
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error || "No se pudo crear." }
  }
  return { success: true, data: mapRow(row) }
}

export async function updateCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
  input: {
    name?: string
    itemKind?: CategoryRow["itemKind"]
    visible?: boolean
    showInSale?: boolean
    showInMenu?: boolean
    sortOrder?: number
  },
  audit: MutationAuditCtx,
): Promise<
  | { success: true; data: CategoryRow }
  | { success: false; error: string; status: 404 | 500 }
> {
  const { data: current, error: fetchError } = await supabase
    .from("categories")
    .select(SELECT)
    .eq("id", categoryId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (fetchError) {
    return { success: false, error: fetchError.message, status: 500 }
  }
  if (!current) {
    return { success: false, error: "Categoría no encontrada", status: 404 }
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (input.name != null) patch.name = input.name
  if (input.itemKind != null) patch.item_kind = input.itemKind
  if (input.visible != null) patch.visible = input.visible
  if (input.showInSale != null) patch.show_in_sale = input.showInSale
  if (input.showInMenu != null) patch.show_in_menu = input.showInMenu
  if (input.sortOrder != null) patch.sort_order = input.sortOrder

  const next = { ...current, ...patch }
  const applied = await auditedUpdate(supabase, {
    kind: "categories.patch",
    table: "categories",
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
  return { success: true, data: mapRow(next as CategoryDbRow) }
}

export async function deleteCategory(
  supabase: SupabaseClient,
  popId: string,
  categoryId: string,
  audit: MutationAuditCtx,
): Promise<{ success: true } | { success: false; error: string; status: 404 | 409 | 500 }> {
  const existing = await getCategory(supabase, popId, categoryId)
  if (!existing.success) return existing

  const { count, error: countError } = await supabase
    .from("articles")
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
      error: `No se puede eliminar "${existing.data.name}": tiene ${count} artículo(s).`,
    }
  }

  const applied = await auditedDelete(supabase, {
    kind: "categories.delete",
    table: "categories",
    id: categoryId,
    ctx: audit,
    popId,
    previous: existing.data,
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

export async function layoutCategories(
  supabase: SupabaseClient,
  popId: string,
  updates: { id: string; sortOrder: number; showInSale: boolean }[],
  audit: MutationAuditCtx,
): Promise<{ success: true } | { success: false; error: string; status: 400 | 500 }> {
  const ids = [...new Set(updates.map((u) => u.id))]
  const { data: validRows, error: validErr } = await supabase
    .from("categories")
    .select("id, sort_order, show_in_sale, show_in_menu")
    .eq("pop_id", popId)
    .in("id", ids)

  if (validErr) return { success: false, error: validErr.message, status: 500 }

  const validIds = new Set((validRows ?? []).map((row) => String(row.id)))
  const filtered = updates.filter((u) => validIds.has(u.id))
  if (filtered.length === 0) {
    return { success: false, error: "Ninguna categoría es válida.", status: 400 }
  }

  const now = new Date().toISOString()
  const ops: AuditOp[] = filtered.map((u) => ({
    op: "update" as const,
    table: "categories",
    id: u.id,
    row: {
      sort_order: u.sortOrder,
      show_in_sale: u.showInSale,
      show_in_menu: u.showInSale,
      updated_at: now,
    },
  }))
  const next = filtered.map((u) => ({
    id: u.id,
    sort_order: u.sortOrder,
    show_in_sale: u.showInSale,
    show_in_menu: u.showInSale,
    updated_at: now,
  }))
  const applied = await applyWithAudit(supabase, {
    kind: "categories.patch",
    ctx: audit,
    popId,
    resourceId: filtered[0]?.id ?? null,
    previous: validRows,
    next,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: 500 }
  }
  return { success: true }
}
