/** Keys reales de POP_PERMS. Misma allowlist que recetas. */

export const STATION_READ = [
  "recipes:read",
  "mesas:read",
  "sale:read",
  "mostrador:read",
] as const

export const STATION_CREATE = ["recipes:create"] as const

export const STATION_UPDATE = ["recipes:update"] as const

export const STATION_DELETE = ["recipes:delete"] as const
