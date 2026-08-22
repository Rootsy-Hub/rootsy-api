/** Keys reales de POP_PERMS. OR por verbo. */

export const CATEGORY_READ = [
  "articles:read",
  "mesas:read",
  "sale:read",
  "mostrador:read",
  "cash_registers:read",
  "inventory:read",
] as const

export const CATEGORY_CREATE = ["articles:create"] as const

export const CATEGORY_UPDATE = ["articles:update"] as const

export const CATEGORY_DELETE = ["articles:delete"] as const
