/** Keys reales de POP_PERMS. OR por verbo. */

export const RECIPE_READ = ["recipes:read"] as const

export const RECIPE_LIST_READ = [
  "recipes:read",
  "mesas:read",
  "sale:read",
  "mostrador:read",
] as const

export const RECIPE_CREATE = ["recipes:create"] as const

export const RECIPE_UPDATE = ["recipes:update"] as const

export const RECIPE_DELETE = ["recipes:delete"] as const
