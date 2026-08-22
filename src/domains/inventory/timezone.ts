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
