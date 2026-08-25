/** Keys reales de POP_PERMS. */

export const CASH_REGISTER_READ = ["cash_registers:read"] as const

/** Turno abierto del usuario en operar. No incluye `cash_registers:read`. */
export const OPERATE_OPEN_SESSION_READ = [
  "sale:read",
  "mesas:read",
  "mostrador:read",
] as const

export const CASH_REGISTER_CREATE = ["cash_registers:create"] as const

export const CASH_REGISTER_UPDATE = ["cash_registers:update"] as const

export const CASH_REGISTER_DELETE = ["cash_registers:delete"] as const
