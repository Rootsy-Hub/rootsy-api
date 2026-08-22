/** Presupuestos tiene keys propias; sale:* queda de compatibilidad. */

export const QUOTE_READ = ["quotes:read", "sale:read"] as const

export const QUOTE_CREATE = ["quotes:create", "sale:create"] as const

export const QUOTE_DELETE = [
  "quotes:delete",
  "quotes:create",
  "sale:delete",
  "sale:create",
] as const
