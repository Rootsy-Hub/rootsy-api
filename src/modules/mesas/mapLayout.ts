const MESA_FLOOR_DECOR_KINDS = [
  "wall_h",
  "wall_v",
  "pillar",
  "entrance",
  "window",
  "bar",
  "register",
  "restroom",
  "kitchen",
  "stairs",
  "plant",
  "planter",
  "label",
  "zone",
] as const

type MesaFloorDecorKind = (typeof MESA_FLOOR_DECOR_KINDS)[number]

type MesaTableShape =
  | { kind: "round"; size: "s" | "m" | "l" | "xl" }
  | { kind: "square"; size: "s" | "m" | "l" }
  | { kind: "rect"; size: "s" | "m" | "l" | "xl" }

export type MesasSalonRow = {
  id: string
  name: string
  sortOrder: number
  isActive: boolean
}

export type MesasTableRow = {
  id: string
  salonId: string
  label: string
  shape: MesaTableShape
  x: number
  y: number
  rotation: number
  seats: number
  sortOrder: number
  isActive: boolean
}

export type MesasFloorDecorRow = {
  id: string
  salonId: string
  kind: MesaFloorDecorKind
  x: number
  y: number
  width: number
  height: number
  rotation: number
  label: string
  sortOrder: number
  isActive: boolean
}

export type MesasLayoutData = {
  salons: MesasSalonRow[]
  tables: MesasTableRow[]
  decors: MesasFloorDecorRow[]
}

export const MESAS_TABLE_SELECT =
  "id, salon_id, label, name, pos_x, pos_y, rotation_deg, shape, capacity, sort_order, is_active"

export const MESAS_DECOR_SELECT =
  "id, salon_id, kind, pos_x, pos_y, rotation_deg, width, height, label, sort_order, is_active"

const ROUND_SIZES = new Set(["s", "m", "l", "xl"])
const SQUARE_SIZES = new Set(["s", "m", "l"])
const RECT_SIZE_ALIASES: Record<string, "s" | "m" | "l" | "xl"> = {
  s: "s",
  sm: "s",
  m: "m",
  md: "m",
  l: "l",
  lg: "l",
  xl: "xl",
}

function parsePos(v: unknown, fallback = 48): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(8, Math.round(n))
}

function parsePositiveInt(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

function parseRotation(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return ((Math.round(n) % 360) + 360) % 360
}

function parseShape(raw: unknown): MesaTableShape {
  if (raw == null || typeof raw !== "object") {
    return { kind: "round", size: "m" }
  }
  const o = raw as Record<string, unknown>
  const kind = o.kind
  const size = o.size
  if (kind === "round" && typeof size === "string" && ROUND_SIZES.has(size)) {
    return { kind: "round", size: size as "s" | "m" | "l" | "xl" }
  }
  if (kind === "square" && typeof size === "string" && SQUARE_SIZES.has(size)) {
    return { kind: "square", size: size as "s" | "m" | "l" }
  }
  if (kind === "rect" && typeof size === "string") {
    const normalized = RECT_SIZE_ALIASES[size]
    if (normalized) return { kind: "rect", size: normalized }
  }
  return { kind: "round", size: "m" }
}

function parseDecorKind(raw: unknown): MesaFloorDecorKind | null {
  if (typeof raw !== "string") return null
  return MESA_FLOOR_DECOR_KINDS.includes(raw as MesaFloorDecorKind)
    ? (raw as MesaFloorDecorKind)
    : null
}

export function mapMesasTableRow(data: {
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
}): MesasTableRow {
  return {
    id: data.id,
    salonId: data.salon_id as string,
    label: (data.label || data.name || "").trim(),
    shape: parseShape(data.shape),
    x: parsePos(data.pos_x),
    y: parsePos(data.pos_y),
    rotation: parseRotation(data.rotation_deg),
    seats: parsePositiveInt(data.capacity, 4),
    sortOrder: data.sort_order ?? 0,
    isActive: Boolean(data.is_active),
  }
}

export function mapMesasDecorRow(data: {
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
}): MesasFloorDecorRow | null {
  const kind = parseDecorKind(data.kind)
  if (!kind) return null
  return {
    id: data.id,
    salonId: data.salon_id,
    kind,
    x: parsePos(data.pos_x),
    y: parsePos(data.pos_y),
    width: parsePositiveInt(data.width, 48),
    height: parsePositiveInt(data.height, 48),
    rotation: parseRotation(data.rotation_deg),
    label: typeof data.label === "string" ? data.label : "",
    sortOrder: data.sort_order ?? 0,
    isActive: Boolean(data.is_active),
  }
}
