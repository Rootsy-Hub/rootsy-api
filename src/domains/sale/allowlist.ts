/** Keys reales de POP_PERMS. */

export const SALE_READ = ["sale:read"] as const

export const SALE_CREATE = ["sale:create"] as const

/** Toolbox de operar (pago / comprobantes): Vender, Mostrador o Mesas. */
export const SALE_TOOLBOX_READ = [
  "sale:read",
  "mostrador:read",
  "mesas:read",
] as const
