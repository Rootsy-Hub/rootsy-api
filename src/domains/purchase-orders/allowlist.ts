/** Órdenes de compra tienen keys propias; operations:* queda de compatibilidad. */

export const PURCHASE_ORDER_READ = [
  "purchase_orders:read",
  "operations:read",
] as const

export const PURCHASE_ORDER_CREATE = [
  "purchase_orders:create",
  "operations:create",
] as const

export const PURCHASE_ORDER_DELETE = [
  "purchase_orders:delete",
  "purchase_orders:create",
  "operations:delete",
  "operations:create",
] as const
