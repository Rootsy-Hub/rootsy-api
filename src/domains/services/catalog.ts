export const SERVICE_BILLING_PERIODS = [
  "none",
  "hourly",
  "weekly",
  "monthly",
  "yearly",
  "custom",
] as const

export type ServiceBillingPeriod = (typeof SERVICE_BILLING_PERIODS)[number]

export const SERVICE_BILLING_PERIOD_LABELS: Record<ServiceBillingPeriod, string> =
  {
    none: "Sin periodicidad",
    hourly: "Por hora",
    weekly: "Semanal",
    monthly: "Mensual",
    yearly: "Anual",
    custom: "Personalizado",
  }

export const SERVICE_LATE_INTEREST_TYPES = ["none", "simple_percent"] as const

export type ServiceLateInterestType = (typeof SERVICE_LATE_INTEREST_TYPES)[number]

export const SERVICE_DISCOUNT_MODES = ["none", "porcentaje", "fijo"] as const

export type ServiceDiscountMode = (typeof SERVICE_DISCOUNT_MODES)[number]

export const SERVICE_PAYMENT_TIMINGS = [
  "during_period",
  "end_of_period",
] as const

export type ServicePaymentTiming = (typeof SERVICE_PAYMENT_TIMINGS)[number]

export const SERVICE_ARTICLE_ITEM_KINDS = [
  "raw_material",
  "supply",
  "merchandise",
] as const

export type ServiceArticleItemKind = (typeof SERVICE_ARTICLE_ITEM_KINDS)[number]

export const SERVICE_DETAILS_GRID_MAX_COLUMNS = 5
export const SERVICE_DETAILS_GRID_MAX_ROWS = 44

export type ServiceDetailsGrid = {
  columns: string[]
  rows: string[][]
}

export function isServiceBillingPeriod(v: unknown): v is ServiceBillingPeriod {
  return (
    typeof v === "string" &&
    (SERVICE_BILLING_PERIODS as readonly string[]).includes(v)
  )
}

export function isServiceLateInterestType(
  v: unknown,
): v is ServiceLateInterestType {
  return (
    typeof v === "string" &&
    (SERVICE_LATE_INTEREST_TYPES as readonly string[]).includes(v)
  )
}

export function isServiceDiscountMode(v: unknown): v is ServiceDiscountMode {
  return (
    typeof v === "string" &&
    (SERVICE_DISCOUNT_MODES as readonly string[]).includes(v)
  )
}

export function isServicePaymentTiming(v: unknown): v is ServicePaymentTiming {
  return (
    typeof v === "string" &&
    (SERVICE_PAYMENT_TIMINGS as readonly string[]).includes(v)
  )
}

export function isServiceArticleItemKind(
  v: string,
): v is ServiceArticleItemKind {
  return (SERVICE_ARTICLE_ITEM_KINDS as readonly string[]).includes(v)
}

export function billingPeriodDisplayLabel(
  period: ServiceBillingPeriod,
  customLabel?: string | null,
): string {
  if (period === "custom") {
    const label = customLabel?.trim()
    return label || SERVICE_BILLING_PERIOD_LABELS.custom
  }
  return SERVICE_BILLING_PERIOD_LABELS[period]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v != null && !Array.isArray(v)
}

export function emptyServiceDetailsGrid(): ServiceDetailsGrid {
  return { columns: [], rows: [] }
}

export function parseServiceDetailsGrid(raw: unknown): ServiceDetailsGrid {
  if (!isRecord(raw)) return emptyServiceDetailsGrid()
  const columnsRaw = Array.isArray(raw.columns) ? raw.columns : []
  const rowsRaw = Array.isArray(raw.rows) ? raw.rows : []
  const columns = columnsRaw
    .slice(0, SERVICE_DETAILS_GRID_MAX_COLUMNS)
    .map((c) => String(c ?? "").trim())
  const colCount = columns.length
  const rows = rowsRaw.slice(0, SERVICE_DETAILS_GRID_MAX_ROWS).map((row) => {
    if (!Array.isArray(row)) return Array.from({ length: colCount }, () => "")
    return Array.from({ length: colCount }, (_, i) =>
      String(row[i] ?? "").trim(),
    )
  })
  return { columns, rows }
}

export function normalizeServiceDetailsGrid(
  grid: ServiceDetailsGrid,
): ServiceDetailsGrid {
  const columns = grid.columns
    .slice(0, SERVICE_DETAILS_GRID_MAX_COLUMNS)
    .map((c) => c.trim())
  const colCount = columns.length
  const rows = grid.rows
    .slice(0, SERVICE_DETAILS_GRID_MAX_ROWS)
    .map((row) =>
      Array.from({ length: colCount }, (_, i) => String(row[i] ?? "").trim()),
    )
    .filter((row) => row.some((cell) => cell.length > 0))
  return { columns, rows }
}

export function serviceDetailsGridHasContent(grid: ServiceDetailsGrid): boolean {
  const normalized = normalizeServiceDetailsGrid(grid)
  if (normalized.columns.some((c) => c.length > 0)) return true
  return normalized.rows.some((row) => row.some((cell) => cell.length > 0))
}

export function normalizeStoredUnitOfMeasure(
  raw: string | null | undefined,
  fallback = "u",
): string {
  const trimmed = String(raw ?? "").trim()
  return trimmed || fallback
}

export function serviceDeleteConfirmPhrase(serviceName: string): string {
  const name = serviceName.trim() || "este servicio"
  return `Eliminar ${name}`
}
