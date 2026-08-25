import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import { auditedInsert, auditedUpdate } from "../../audit/simpleWrite.js"
import type { MutationAuditCtx } from "../../audit/types.js"
import {
  mapDecor,
  mapSalon,
  mapTable,
  parsePos,
  parseRotation,
  parsePositiveInt,
  type MutateFail,
} from "./map.js"
import {
  DECOR_SELECT,
  TABLE_SELECT,
  type DecorBody,
  type MesasDecor,
  type MesasSalon,
  type MesasTable,
  type SalonBody,
  type TableBody,
} from "./schema.js"

type OkSalon = { success: true; salon: MesasSalon }
type OkTable = { success: true; table: MesasTable }
type OkDecor = { success: true; decor: MesasDecor }
type Ok = { success: true }

async function loadSalon(
  supabase: SupabaseClient,
  popId: string,
  salonId: string,
) {
  return supabase
    .from("dining_salons")
    .select("id, name, sort_order, is_active")
    .eq("id", salonId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
}

async function loadTable(
  supabase: SupabaseClient,
  popId: string,
  tableId: string,
) {
  return supabase
    .from("dining_tables")
    .select(TABLE_SELECT)
    .eq("id", tableId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
}

async function loadDecor(
  supabase: SupabaseClient,
  popId: string,
  decorId: string,
) {
  return supabase
    .from("dining_floor_decors")
    .select(DECOR_SELECT)
    .eq("id", decorId)
    .eq("pop_id", popId)
    .is("deleted_at", null)
    .maybeSingle()
}

export async function createSalon(
  supabase: SupabaseClient,
  popId: string,
  input: SalonBody,
  audit: MutationAuditCtx,
): Promise<OkSalon | MutateFail> {
  const name = input.name.trim()
  if (!name) {
    return { success: false, error: "El nombre del salón es obligatorio.", status: 400 }
  }
  const id = randomUUID()
  const row = {
    id,
    pop_id: popId,
    name,
    sort_order: input.sortOrder,
    is_active: input.isActive,
  }
  const applied = await auditedInsert(supabase, {
    kind: "mesas.salon.create",
    table: "dining_salons",
    row,
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadSalon(supabase, popId, id)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer el salón creado.",
      status: 500,
    }
  }
  return { success: true, salon: mapSalon(data) }
}

export async function updateSalon(
  supabase: SupabaseClient,
  popId: string,
  salonId: string,
  input: Partial<SalonBody>,
  audit: MutationAuditCtx,
): Promise<OkSalon | MutateFail> {
  const { data: existing, error: existingErr } = await loadSalon(
    supabase,
    popId,
    salonId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "El salón no existe.", status: 404 }
  }
  const patch: Record<string, unknown> = {}
  if (input.name != null) {
    const name = input.name.trim()
    if (!name) {
      return {
        success: false,
        error: "El nombre del salón es obligatorio.",
        status: 400,
      }
    }
    patch.name = name
  }
  if (input.sortOrder != null) patch.sort_order = input.sortOrder
  if (input.isActive != null) patch.is_active = input.isActive
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.salon.patch",
    table: "dining_salons",
    id: salonId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadSalon(supabase, popId, salonId)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer el salón.",
      status: 500,
    }
  }
  return { success: true, salon: mapSalon(data) }
}

export async function deleteSalon(
  supabase: SupabaseClient,
  popId: string,
  salonId: string,
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const { data: existing, error: existingErr } = await loadSalon(
    supabase,
    popId,
    salonId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "El salón no existe.", status: 404 }
  }

  const { count, error: countErr } = await supabase
    .from("dining_tables")
    .select("id", { count: "exact", head: true })
    .eq("pop_id", popId)
    .eq("salon_id", salonId)
    .is("deleted_at", null)
  if (countErr) {
    return { success: false, error: countErr.message, status: 500 }
  }
  if ((count ?? 0) > 0) {
    return {
      success: false,
      error: "No se puede eliminar un salón que todavía tiene mesas.",
      status: 400,
    }
  }

  const now = new Date().toISOString()
  const { data: decors } = await supabase
    .from("dining_floor_decors")
    .select("id")
    .eq("pop_id", popId)
    .eq("salon_id", salonId)
    .is("deleted_at", null)

  const ops = [
    {
      op: "update" as const,
      table: "dining_salons",
      id: salonId,
      row: { deleted_at: now, is_active: false },
    },
    ...(decors ?? []).map((decor) => ({
      op: "update" as const,
      table: "dining_floor_decors",
      id: decor.id as string,
      row: { deleted_at: now, is_active: false },
    })),
  ]

  const applied = await applyWithAudit(supabase, {
    kind: "mesas.salon.delete",
    ctx: audit,
    popId,
    resourceId: salonId,
    previous: existing,
    next: { ...existing, deleted_at: now, is_active: false },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function reorderRows(
  supabase: SupabaseClient,
  popId: string,
  table: "dining_salons" | "dining_tables" | "dining_floor_decors",
  updates: { id: string; sortOrder: number }[],
  audit: MutationAuditCtx,
  kind: string,
): Promise<Ok | MutateFail> {
  if (updates.length === 0) return { success: true }
  const ops = updates.map((update) => ({
    op: "update" as const,
    table,
    id: update.id,
    row: { sort_order: Math.max(0, Math.trunc(update.sortOrder)) },
  }))
  const applied = await applyWithAudit(supabase, {
    kind,
    ctx: audit,
    popId,
    previous: null,
    next: updates,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function reorderTablesInSalon(
  supabase: SupabaseClient,
  popId: string,
  salonId: string,
  updates: { id: string; sortOrder: number }[],
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const ids = updates.map((u) => u.id)
  if (ids.length > 0) {
    const { data: validRows, error } = await supabase
      .from("dining_tables")
      .select("id")
      .eq("pop_id", popId)
      .eq("salon_id", salonId)
      .in("id", ids)
      .is("deleted_at", null)
    if (error) return { success: false, error: error.message, status: 500 }
    const validIds = new Set((validRows ?? []).map((r) => String(r.id)))
    if (ids.some((id) => !validIds.has(id))) {
      return {
        success: false,
        error: "Hay mesas que no pertenecen a este salón.",
        status: 400,
      }
    }
  }
  return reorderRows(
    supabase,
    popId,
    "dining_tables",
    updates,
    audit,
    "mesas.tables.reorder",
  )
}

export async function reorderDecorsInSalon(
  supabase: SupabaseClient,
  popId: string,
  salonId: string,
  updates: { id: string; sortOrder: number }[],
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const ids = updates.map((u) => u.id)
  if (ids.length > 0) {
    const { data: validRows, error } = await supabase
      .from("dining_floor_decors")
      .select("id")
      .eq("pop_id", popId)
      .eq("salon_id", salonId)
      .in("id", ids)
      .is("deleted_at", null)
    if (error) return { success: false, error: error.message, status: 500 }
    const validIds = new Set((validRows ?? []).map((r) => String(r.id)))
    if (ids.some((id) => !validIds.has(id))) {
      return {
        success: false,
        error: "Hay elementos que no pertenecen a este salón.",
        status: 400,
      }
    }
  }
  return reorderRows(
    supabase,
    popId,
    "dining_floor_decors",
    updates,
    audit,
    "mesas.decors.reorder",
  )
}

function tableRow(popId: string, input: TableBody, id?: string) {
  const label = input.label.trim()
  return {
    ...(id ? { id } : {}),
    pop_id: popId,
    salon_id: input.salonId,
    name: label,
    label,
    pos_x: parsePos(input.x),
    pos_y: parsePos(input.y),
    shape: { kind: input.shape.kind, size: input.shape.size },
    capacity: parsePositiveInt(input.seats, 4),
    sort_order: input.sortOrder,
    is_active: input.isActive,
  }
}

export async function createTable(
  supabase: SupabaseClient,
  popId: string,
  input: TableBody,
  audit: MutationAuditCtx,
): Promise<OkTable | MutateFail> {
  const label = input.label.trim()
  if (!label) {
    return {
      success: false,
      error: "El número o nombre de mesa es obligatorio.",
      status: 400,
    }
  }
  const id = randomUUID()
  const applied = await auditedInsert(supabase, {
    kind: "mesas.table.create",
    table: "dining_tables",
    row: tableRow(popId, input, id),
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadTable(supabase, popId, id)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer la mesa creada.",
      status: 500,
    }
  }
  return { success: true, table: mapTable(data) }
}

export async function updateTable(
  supabase: SupabaseClient,
  popId: string,
  tableId: string,
  input: Partial<TableBody>,
  audit: MutationAuditCtx,
): Promise<OkTable | MutateFail> {
  const { data: existing, error: existingErr } = await loadTable(
    supabase,
    popId,
    tableId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "La mesa no existe.", status: 404 }
  }
  const patch: Record<string, unknown> = {}
  if (input.label != null) {
    const label = input.label.trim()
    if (!label) {
      return {
        success: false,
        error: "El número o nombre de mesa es obligatorio.",
        status: 400,
      }
    }
    patch.label = label
    patch.name = label
  }
  if (input.salonId != null) patch.salon_id = input.salonId
  if (input.x != null) patch.pos_x = parsePos(input.x)
  if (input.y != null) patch.pos_y = parsePos(input.y)
  if (input.shape != null) {
    patch.shape = { kind: input.shape.kind, size: input.shape.size }
  }
  if (input.seats != null) patch.capacity = parsePositiveInt(input.seats, 4)
  if (input.sortOrder != null) patch.sort_order = input.sortOrder
  if (input.isActive != null) patch.is_active = input.isActive

  const applied = await auditedUpdate(supabase, {
    kind: "mesas.table.patch",
    table: "dining_tables",
    id: tableId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadTable(supabase, popId, tableId)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer la mesa.",
      status: 500,
    }
  }
  return { success: true, table: mapTable(data) }
}

export async function deleteTable(
  supabase: SupabaseClient,
  popId: string,
  tableId: string,
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const { data: existing, error: existingErr } = await loadTable(
    supabase,
    popId,
    tableId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "La mesa no existe.", status: 404 }
  }
  const now = new Date().toISOString()
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.table.delete",
    table: "dining_tables",
    id: tableId,
    row: { deleted_at: now, is_active: false },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, deleted_at: now, is_active: false },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

function decorRow(popId: string, input: DecorBody, id?: string) {
  return {
    ...(id ? { id } : {}),
    pop_id: popId,
    salon_id: input.salonId,
    kind: input.kind,
    pos_x: parsePos(input.x),
    pos_y: parsePos(input.y),
    width: parsePositiveInt(input.width, 48),
    height: parsePositiveInt(input.height, 48),
    label: input.label.trim(),
    sort_order: input.sortOrder,
    is_active: input.isActive,
  }
}

export async function createDecor(
  supabase: SupabaseClient,
  popId: string,
  input: DecorBody,
  audit: MutationAuditCtx,
): Promise<OkDecor | MutateFail> {
  const id = randomUUID()
  const applied = await auditedInsert(supabase, {
    kind: "mesas.decor.create",
    table: "dining_floor_decors",
    row: decorRow(popId, input, id),
    ctx: audit,
    popId,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadDecor(supabase, popId, id)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer el elemento creado.",
      status: 500,
    }
  }
  const decor = mapDecor(data)
  if (!decor) {
    return { success: false, error: "Tipo de elemento no válido.", status: 400 }
  }
  return { success: true, decor }
}

export async function updateDecor(
  supabase: SupabaseClient,
  popId: string,
  decorId: string,
  input: Partial<DecorBody>,
  audit: MutationAuditCtx,
): Promise<OkDecor | MutateFail> {
  const { data: existing, error: existingErr } = await loadDecor(
    supabase,
    popId,
    decorId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "El elemento no existe.", status: 404 }
  }
  const patch: Record<string, unknown> = {}
  if (input.salonId != null) patch.salon_id = input.salonId
  if (input.kind != null) patch.kind = input.kind
  if (input.x != null) patch.pos_x = parsePos(input.x)
  if (input.y != null) patch.pos_y = parsePos(input.y)
  if (input.width != null) patch.width = parsePositiveInt(input.width, 48)
  if (input.height != null) patch.height = parsePositiveInt(input.height, 48)
  if (input.label != null) patch.label = input.label.trim()
  if (input.sortOrder != null) patch.sort_order = input.sortOrder
  if (input.isActive != null) patch.is_active = input.isActive

  const applied = await auditedUpdate(supabase, {
    kind: "mesas.decor.patch",
    table: "dining_floor_decors",
    id: decorId,
    row: patch,
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, ...patch },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  const { data, error } = await loadDecor(supabase, popId, decorId)
  if (error || !data) {
    return {
      success: false,
      error: error?.message || "No se pudo leer el elemento.",
      status: 500,
    }
  }
  const decor = mapDecor(data)
  if (!decor) {
    return { success: false, error: "Tipo de elemento no válido.", status: 400 }
  }
  return { success: true, decor }
}

export async function deleteDecor(
  supabase: SupabaseClient,
  popId: string,
  decorId: string,
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const { data: existing, error: existingErr } = await loadDecor(
    supabase,
    popId,
    decorId,
  )
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "El elemento no existe.", status: 404 }
  }
  const now = new Date().toISOString()
  const applied = await auditedUpdate(supabase, {
    kind: "mesas.decor.delete",
    table: "dining_floor_decors",
    id: decorId,
    row: { deleted_at: now, is_active: false },
    ctx: audit,
    popId,
    previous: existing,
    next: { ...existing, deleted_at: now, is_active: false },
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}

export async function saveLayoutPositions(
  supabase: SupabaseClient,
  popId: string,
  input: {
    tables?: { id: string; x: number; y: number; rotation?: number }[]
    decors?: { id: string; x: number; y: number; rotation?: number }[]
  },
  audit: MutationAuditCtx,
): Promise<Ok | MutateFail> {
  const tables = input.tables ?? []
  const decors = input.decors ?? []
  const ops = [
    ...tables.map((table) => {
      const row: Record<string, unknown> = {
        pos_x: parsePos(table.x),
        pos_y: parsePos(table.y),
      }
      if (table.rotation !== undefined) {
        row.rotation_deg = parseRotation(table.rotation)
      }
      return {
        op: "update" as const,
        table: "dining_tables",
        id: table.id,
        row,
      }
    }),
    ...decors.map((decor) => {
      const row: Record<string, unknown> = {
        pos_x: parsePos(decor.x),
        pos_y: parsePos(decor.y),
      }
      if (decor.rotation !== undefined) {
        row.rotation_deg = parseRotation(decor.rotation)
      }
      return {
        op: "update" as const,
        table: "dining_floor_decors",
        id: decor.id,
        row,
      }
    }),
  ]
  if (ops.length === 0) return { success: true }
  const applied = await applyWithAudit(supabase, {
    kind: "mesas.layout.positions",
    ctx: audit,
    popId,
    previous: null,
    next: input,
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }
  return { success: true }
}
