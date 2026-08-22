/** Keys reales de POP_PERMS. */

export const OPERATION_READ = ["operations:read"] as const

export const OPERATION_READ_OR_SALE = [
  "operations:read",
  "sale:read",
] as const
