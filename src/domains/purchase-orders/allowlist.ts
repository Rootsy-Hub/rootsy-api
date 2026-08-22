/** Keys reales de POP_PERMS. Órdenes de compra cuelgan de operaciones. */

export const PURCHASE_ORDER_READ = ["operations:read"] as const

export const PURCHASE_ORDER_CREATE = ["operations:create"] as const

export const PURCHASE_ORDER_DELETE = [
  "operations:delete",
  "operations:create",
] as const
