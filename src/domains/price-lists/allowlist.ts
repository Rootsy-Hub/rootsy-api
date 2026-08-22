/** Keys reales de POP_PERMS. OR por verbo. */

export const PRICE_LIST_READ = [
  "articles:read",
  "recipes:read",
  "sale:read",
  "mesas:read",
  "mostrador:read",
  "cash_registers:read",
  "inventory:read",
] as const

export const PRICE_LIST_CREATE = ["articles:create"] as const

export const PRICE_LIST_UPDATE = ["articles:update"] as const

export const PRICE_LIST_DELETE = ["articles:delete"] as const
