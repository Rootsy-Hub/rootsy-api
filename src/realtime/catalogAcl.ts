/** Mismo ACL que el GET de listado de artículos y categorías. */
export const CATALOG_REALTIME_READ = [
  "articles:read",
  "sale:read",
  "mesas:read",
  "mostrador:read",
  "cash_registers:read",
  "inventory:read",
] as const
