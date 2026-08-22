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

function addCalendarDays(isoDate: string, days: number): string {
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
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!match) return "+00:00"
  const hh = String(match[2]).padStart(2, "0")
  const mm = String(match[3] ?? "00").padStart(2, "0")
  return `${match[1]}${hh}:${mm}`
}

export function localDateStartTimestamp(
  timeZone: string,
  isoDate: string,
): string {
  const off = timezoneOffsetForLocalDate(timeZone, isoDate)
  return `${isoDate}T00:00:00${off}`
}

export function localDateExclusiveEndTimestamp(
  timeZone: string,
  isoDate: string,
): string {
  return localDateStartTimestamp(timeZone, addCalendarDays(isoDate, 1))
}
