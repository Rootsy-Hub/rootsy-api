/** Keys reales. El tablero usa comandas; envío/anulación también desde mesas o mostrador. */

export const COMANDAS_READ = [
  "comandas:read",
  "mesas:read",
  "mostrador:read",
] as const

export const COMANDAS_UPDATE = [
  "comandas:update",
  "mesas:update",
  "mostrador:update",
] as const

/** GET: ver o mover alcanza (el tablero/checkout no exige read si ya tiene update). */
export const COMANDAS_GET = [...COMANDAS_READ, ...COMANDAS_UPDATE] as const
