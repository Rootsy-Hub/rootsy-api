/** Keys reales de POP_PERMS. OR por verbo. */

export const EXPENSE_CATEGORY_READ = [
  "expenses:read",
  "operations:read",
  "accounts:read",
] as const

/** En web create/delete de categorías usan expenses:update. */
export const EXPENSE_CATEGORY_CREATE = [
  "expenses:create",
  "expenses:update",
] as const

export const EXPENSE_CATEGORY_UPDATE = ["expenses:update"] as const

export const EXPENSE_CATEGORY_DELETE = [
  "expenses:delete",
  "expenses:update",
] as const
