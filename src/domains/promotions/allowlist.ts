/** Keys reales de POP_PERMS. OR por verbo. */

export const PROMOTION_READ = ["promotions:read"] as const

/** Listado dump para operar (Vender / Mesas / Mostrador) y ABM. */
export const PROMOTION_LIST_READ = [
  "promotions:read",
  "sale:read",
  "mesas:read",
  "mostrador:read",
] as const

export const PROMOTION_CREATE = ["promotions:create"] as const

export const PROMOTION_UPDATE = ["promotions:update"] as const

export const PROMOTION_DELETE = ["promotions:delete"] as const
