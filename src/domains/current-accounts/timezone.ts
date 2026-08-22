const COUNTRY_TO_IANA: Record<string, string> = {
  AR: "America/Argentina/Buenos_Aires",
  CL: "America/Santiago",
  UY: "America/Montevideo",
  PY: "America/Asuncion",
  BO: "America/La_Paz",
  BR: "America/Sao_Paulo",
  CO: "America/Bogota",
  EC: "America/Guayaquil",
  PE: "America/Lima",
  VE: "America/Caracas",
  MX: "America/Mexico_City",
  US: "America/New_York",
  CA: "America/Toronto",
  ES: "Europe/Madrid",
}

export function timezoneForPopLedger(
  country: string | null | undefined,
  siteId: string,
): string {
  const c = country?.trim().toUpperCase()
  if (c && COUNTRY_TO_IANA[c]) return COUNTRY_TO_IANA[c]
  if (siteId.trim().toLowerCase() === "arg") {
    return "America/Argentina/Buenos_Aires"
  }
  return "UTC"
}

export function timestampToLocalDateIso(
  isoTimestamp: string,
  timeZone: string,
): string {
  const raw = isoTimestamp.trim()
  if (!raw) return ""
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10)
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(d)
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isCalendarDateOnly(value: string): boolean {
  const raw = value.trim()
  return CALENDAR_DATE_RE.test(raw) && !/T/.test(raw)
}

export function toPopCalendarDate(value: string, timeZone: string): string {
  const raw = value.trim()
  if (!raw) return ""
  if (isCalendarDateOnly(raw)) return raw.slice(0, 10)
  return timestampToLocalDateIso(raw, timeZone)
}
