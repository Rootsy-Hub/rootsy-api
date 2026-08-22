/** Keys reales de POP_PERMS. */

export const INVENTORY_READ = ["inventory:read"] as const

export const INVENTORY_CREATE = ["inventory:create"] as const

export const INVENTORY_UPDATE = ["inventory:update"] as const

export const INVENTORY_DELETE = ["inventory:delete"] as const

export const INVENTORY_READ_OR_CREATE = [
  "inventory:read",
  "inventory:create",
] as const

export const INVENTORY_WRITE_EXPIRY = [
  "inventory:update",
  "inventory:create",
] as const

export const ARTICLE_UPDATE = ["articles:update"] as const
