import type { PopSettingsForm } from "./schema.js"

export const OPERATIONAL_DAY_CLOSE_TIME_KEY = "operational_day_close_time"
export const DEFAULT_OPERATIONAL_DAY_CLOSE_TIME = "00:00"

export function normalizeOperationalDayCloseTime(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_OPERATIONAL_DAY_CLOSE_TIME
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return DEFAULT_OPERATIONAL_DAY_CLOSE_TIME
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return DEFAULT_OPERATIONAL_DAY_CLOSE_TIME
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

export function operationalDayCloseTimeFromSettings(settings: unknown): string {
  if (!settings || typeof settings !== "object") {
    return DEFAULT_OPERATIONAL_DAY_CLOSE_TIME
  }
  return normalizeOperationalDayCloseTime(
    (settings as Record<string, unknown>)[OPERATIONAL_DAY_CLOSE_TIME_KEY],
  )
}

export function asSettingsObject(settings: unknown): Record<string, unknown> {
  if (settings && typeof settings === "object") {
    return { ...(settings as Record<string, unknown>) }
  }
  return {}
}

function asText(value: unknown): string {
  return value != null ? String(value) : ""
}

function asJsonString(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

export function mapPopSettingsForm(row: Record<string, unknown>): PopSettingsForm {
  const inicio = row.fiscal_inicio_actividades_date
  return {
    name: asText(row.name),
    phone: asText(row.phone),
    country: asText(row.country),
    state: asText(row.state),
    city: asText(row.city),
    streetAddress: asText(row.street_address),
    postalCode: asText(row.postal_code),
    imageUrl: asText(row.image_url),
    invoiceLogoUrl: asText(row.invoice_logo_url),
    backgroundImageUrl: asText(row.background_image_url),
    fiscalCuit: asText(row.fiscal_cuit),
    fiscalRazonSocial: asText(row.fiscal_razon_social),
    fiscalInicioActividadesDate: inicio != null ? String(inicio).slice(0, 10) : "",
    fiscalIngresosBrutosText: asText(row.fiscal_ingresos_brutos_text),
    fiscalPadronActividadesJson: asJsonString(row.fiscal_padron_actividades_json),
    fiscalActividadSeleccionadaId: asText(row.fiscal_actividad_seleccionada_id),
    fiscalPadronSyncedAt:
      row.fiscal_padron_synced_at != null
        ? String(row.fiscal_padron_synced_at)
        : null,
    operationalDayCloseTime: operationalDayCloseTimeFromSettings(row.settings),
  }
}

export function parsePadronActividadesJson(
  raw: string,
): { ok: true; value: unknown[] | null } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: null }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "Lista de actividades inválida." }
    }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, error: "Lista de actividades inválida." }
  }
}
