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

export function entryDateIsoInTimezone(timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date())
}

/** Fecha calendario YYYY-MM-DD de un timestamptz ISO en la zona del POP. */
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

/** Suma días a una fecha calendario YYYY-MM-DD (sin desfase por TZ del servidor). */
export function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  if (!y || !m || !d) return isoDate
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

function timezoneOffsetForLocalDate(timeZone: string, isoDate: string): string {
  const probe = new Date(`${isoDate}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(probe)
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT"
  if (tzName === "GMT" || tzName === "UTC") return "+00:00"
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!m) return "+00:00"
  const sign = m[1]
  const hh = String(m[2]).padStart(2, "0")
  const mm = String(m[3] ?? "00").padStart(2, "0")
  return `${sign}${hh}:${mm}`
}

/** Inicio del día calendario local del POP, como instante ISO (timestamptz). */
export function localDateStartTimestamp(
  timeZone: string,
  isoDate: string,
): string {
  const off = timezoneOffsetForLocalDate(timeZone, isoDate)
  return `${isoDate}T00:00:00${off}`
}

/** Inicio del día siguiente (límite exclusivo para rangos hasta fin de día inclusive). */
export function localDateExclusiveEndTimestamp(
  timeZone: string,
  isoDate: string,
): string {
  return localDateStartTimestamp(timeZone, addCalendarDays(isoDate, 1))
}
