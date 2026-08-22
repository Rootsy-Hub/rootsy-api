import type { SupabaseClient } from "@supabase/supabase-js"
import {
  addCalendarDays,
  timestampToLocalDateIso,
  timezoneForPopLedger,
} from "./timezone.js"

/** Clave en `pops.settings` — hora local a la que cierra el día operativo (HH:mm). */
export const POP_SETTINGS_OPERATIONAL_DAY_CLOSE_TIME_KEY =
  "operational_day_close_time"

export const DEFAULT_OPERATIONAL_DAY_CLOSE_TIME = "00:00"

/** Normaliza HH:mm; default 00:00 si es inválido. */
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

export function operationalDayCloseTimeFromSettings(
  settings: unknown,
): string {
  if (!settings || typeof settings !== "object") {
    return DEFAULT_OPERATIONAL_DAY_CLOSE_TIME
  }
  return normalizeOperationalDayCloseTime(
    (settings as Record<string, unknown>)[
      POP_SETTINGS_OPERATIONAL_DAY_CLOSE_TIME_KEY
    ],
  )
}

function closeTimeToMinutes(closeTime: string): number {
  const normalized = normalizeOperationalDayCloseTime(closeTime)
  const [hours, minutes] = normalized.split(":").map(Number)
  return hours * 60 + minutes
}

function timestampToLocalMinutes(
  isoTimestamp: string,
  timeZone: string,
): number {
  const instant = new Date(isoTimestamp)
  if (Number.isNaN(instant.getTime())) return 0
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(instant)
  const hourRaw = Number(parts.find((p) => p.type === "hour")?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0)
  const hour = hourRaw === 24 ? 0 : hourRaw
  return hour * 60 + minute
}

/**
 * Fecha operativa YYYY-MM-DD de un instante.
 * Con cierre 05:00, ventas de 04:30 del 15/08 pertenecen al día operativo 14/08.
 */
export function operationalDayKey(
  isoTimestamp: string,
  timeZone: string,
  closeTime: string = DEFAULT_OPERATIONAL_DAY_CLOSE_TIME,
): string {
  const calendarDate = timestampToLocalDateIso(isoTimestamp, timeZone)
  if (!calendarDate) return ""
  const closeMinutes = closeTimeToMinutes(closeTime)
  if (closeMinutes === 0) return calendarDate
  if (timestampToLocalMinutes(isoTimestamp, timeZone) < closeMinutes) {
    return addCalendarDays(calendarDate, -1)
  }
  return calendarDate
}

export function isOperationalDayInRange(
  operationalDay: string,
  from: string | null,
  to: string | null,
): boolean {
  if (!operationalDay) return false
  if (from && operationalDay < from) return false
  if (to && operationalDay > to) return false
  return true
}

/** Amplía el fetch calendario para capturar madrugadas del borde operativo. */
export function expandCalendarBoundsForOperationalFetch(
  from: string | null,
  to: string | null,
): { from: string | null; to: string | null } {
  if (!from || !to) return { from, to }
  return {
    from: addCalendarDays(from, -1),
    to: addCalendarDays(to, 1),
  }
}

export function filterSalesByOperationalPeriod<T extends { soldAt: string }>(
  rows: T[],
  from: string | null,
  to: string | null,
  timeZone: string,
  closeTime: string,
): T[] {
  if (!from && !to) return rows
  return rows.filter((row) =>
    isOperationalDayInRange(
      operationalDayKey(row.soldAt, timeZone, closeTime),
      from,
      to,
    ),
  )
}

export function usesOperationalDayFilter(
  closeTime: string,
  from: string | null,
  to: string | null,
): boolean {
  return Boolean(
    (from || to) &&
      normalizeOperationalDayCloseTime(closeTime) !==
        DEFAULT_OPERATIONAL_DAY_CLOSE_TIME,
  )
}

export async function loadPopOperationalContext(
  supabase: SupabaseClient,
  popId: string,
  popSiteId: string,
): Promise<{
  timeZone: string
  operationalDayCloseTime: string
  popName: string
}> {
  const { data } = await supabase
    .from("pops")
    .select("name, country, settings")
    .eq("id", popId)
    .maybeSingle()
  return {
    timeZone: timezoneForPopLedger(
      data?.country != null ? String(data.country) : null,
      popSiteId,
    ),
    operationalDayCloseTime: operationalDayCloseTimeFromSettings(
      data?.settings,
    ),
    popName: data?.name != null ? String(data.name ?? "") : "",
  }
}
