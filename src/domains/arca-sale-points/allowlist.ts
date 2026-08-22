/** Keys reales de POP_PERMS. OR por verbo. */

export const ARCA_SALE_POINT_READ = ["invoices:read"] as const

export const ARCA_SALE_POINT_WRITE = [
  "invoices:update",
  "invoices:create",
] as const
