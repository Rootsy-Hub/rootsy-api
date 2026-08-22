/** Keys reales de POP_PERMS. OR por verbo. */

export const RECIPE_CATEGORY_READ = [
  "recipes:read",
  "mesas:read",
  "sale:read",
  "mostrador:read",
] as const

export const RECIPE_CATEGORY_CREATE = ["recipes:create"] as const

export const RECIPE_CATEGORY_UPDATE = ["recipes:update"] as const

export const RECIPE_CATEGORY_DELETE = ["recipes:delete"] as const
