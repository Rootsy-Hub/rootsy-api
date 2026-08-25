import {
  MESA_FLOOR_DECOR_KINDS,
  type DecorKind,
  type FloorStatus,
  type MesaReservation,
  type MesaSession,
  type MesasDecor,
  type MesasSalon,
  type MesasTable,
  type ReservationStatus,
  type TableShape,
} from "./schema.js"

const RECT_SIZE_ALIASES: Record<string, "s" | "m" | "l" | "xl"> = {
  s: "s",
  sm: "s",
  m: "m",
  md: "m",
  l: "l",
  lg: "l",
  xl: "xl",
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v != null && !Array.isArray(v)
}

export function parsePos(v: unknown, fallback = 48): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(8, Math.round(n))
}

export function parseRotation(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return ((Math.round(n) % 360) + 360) % 360
}

export function parsePositiveInt(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

export function parseShape(raw: unknown): TableShape {
  if (raw == null || typeof raw !== "object") {
    return { kind: "round", size: "m" }
  }
  const o = raw as Record<string, unknown>
  const kind = o.kind
  const size = o.size
  if (kind === "round" && typeof size === "string" && ["s", "m", "l", "xl"].includes(size)) {
    return { kind: "round", size: size as "s" | "m" | "l" | "xl" }
  }
  if (kind === "square" && typeof size === "string" && ["s", "m", "l"].includes(size)) {
    return { kind: "square", size: size as "s" | "m" | "l" }
  }
  if (kind === "rect" && typeof size === "string") {
    const normalized = RECT_SIZE_ALIASES[size]
    if (normalized) return { kind: "rect", size: normalized }
  }
  return { kind: "round", size: "m" }
}

export function parseDecorKind(raw: unknown): DecorKind | null {
  if (typeof raw !== "string") return null
  return (MESA_FLOOR_DECOR_KINDS as readonly string[]).includes(raw)
    ? (raw as DecorKind)
    : null
}

export function normalizeTableIds(
  primaryTableId: string,
  extraTableIds: string[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [primaryTableId, ...extraTableIds]) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function mapSalon(row: {
  id: string
  name: string
  sort_order: number | null
  is_active: boolean | null
}): MesasSalon {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order ?? 0,
    isActive: Boolean(row.is_active),
  }
}

export function mapTable(row: {
  id: string
  salon_id: string | null
  label: string | null
  name: string | null
  pos_x: unknown
  pos_y: unknown
  rotation_deg?: unknown
  shape: unknown
  capacity: unknown
  sort_order: number | null
  is_active: boolean | null
}): MesasTable {
  return {
    id: row.id,
    salonId: row.salon_id as string,
    label: (row.label || row.name || "").trim(),
    shape: parseShape(row.shape),
    x: parsePos(row.pos_x),
    y: parsePos(row.pos_y),
    rotation: parseRotation(row.rotation_deg),
    seats: parsePositiveInt(row.capacity, 4),
    sortOrder: row.sort_order ?? 0,
    isActive: Boolean(row.is_active),
  }
}

export function mapDecor(row: {
  id: string
  salon_id: string
  kind: unknown
  pos_x: unknown
  pos_y: unknown
  rotation_deg?: unknown
  width: unknown
  height: unknown
  label: unknown
  sort_order: number | null
  is_active: boolean | null
}): MesasDecor | null {
  const kind = parseDecorKind(row.kind)
  if (!kind) return null
  return {
    id: row.id,
    salonId: row.salon_id,
    kind,
    x: parsePos(row.pos_x),
    y: parsePos(row.pos_y),
    width: parsePositiveInt(row.width, 48),
    height: parsePositiveInt(row.height, 48),
    rotation: parseRotation(row.rotation_deg),
    label: typeof row.label === "string" ? row.label : "",
    sortOrder: row.sort_order ?? 0,
    isActive: Boolean(row.is_active),
  }
}

function checkoutFromMetadata(
  metadata: unknown,
): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null
  return isRecord(metadata.checkout) ? metadata.checkout : null
}

function floorStatusFromMetadata(metadata: unknown): FloorStatus {
  if (!isRecord(metadata)) return "open"
  return metadata.floor_status === "paying" ? "paying" : "open"
}

export function mapSession(row: {
  id: string
  dining_table_id: string
  waiter_user_id: string | null
  guest_count: number | null
  notes: string | null
  opened_at: string
  updated_at: string
  metadata: unknown
  table_session_tables: { dining_table_id: string }[] | null
}): MesaSession {
  const extraIds = (row.table_session_tables ?? []).map((t) => t.dining_table_id)
  return {
    id: row.id,
    tableIds: normalizeTableIds(row.dining_table_id, extraIds),
    waiterId: row.waiter_user_id ?? "",
    guestCount: row.guest_count ?? null,
    note: row.notes?.trim() ?? "",
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    checkout: checkoutFromMetadata(row.metadata),
    floorStatus: floorStatusFromMetadata(row.metadata),
  }
}

export function parseReservationStatus(raw: unknown): ReservationStatus {
  const value = typeof raw === "string" ? raw.trim() : ""
  if (
    value === "pending" ||
    value === "confirmed" ||
    value === "seated" ||
    value === "completed" ||
    value === "expired" ||
    value === "no_show" ||
    value === "cancelled"
  ) {
    return value
  }
  return "confirmed"
}

export function mapReservation(row: {
  id: string
  dining_table_id: string | null
  client_id: string | null
  client_name: string | null
  guest_count: number | null
  arrival_at: string
  status: string | null
  notes: string | null
  updated_at: string
  table_reservation_tables?: { dining_table_id: string }[] | null
}): MesaReservation {
  const guestCount =
    row.guest_count != null && Number.isFinite(row.guest_count)
      ? Math.max(1, Math.min(50, Math.round(row.guest_count)))
      : null
  const extraIds = (row.table_reservation_tables ?? []).map(
    (item) => item.dining_table_id,
  )
  const tableIds = row.dining_table_id
    ? normalizeTableIds(row.dining_table_id, extraIds)
    : []
  return {
    id: row.id,
    tableId: row.dining_table_id,
    tableIds,
    clientId: row.client_id,
    clientName: row.client_name?.trim() ?? "",
    guestCount,
    arrivalAt: row.arrival_at,
    status: parseReservationStatus(row.status),
    note: row.notes?.trim() ?? "",
    updatedAt: row.updated_at,
  }
}

export type MutateFail = {
  success: false
  error: string
  status: 400 | 404 | 409 | 500
}
