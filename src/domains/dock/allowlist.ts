/** Keys reales de POP_PERMS. OR por verbo.
 * Preferencia personal: basta un permiso de lectura habitual.
 * El sidecar ya valida acceso al POP. */

export const DOCK_READ = [
  "sale:read",
  "mesas:read",
  "mostrador:read",
  "articles:read",
  "settings:read",
  "inventory:read",
  "cash_registers:read",
  "clients:read",
  "expenses:read",
  "operations:read",
  "recipes:read",
  "services:read",
  "hr:read",
  "accounts:read",
  "invoices:read",
  "suppliers:read",
  "printers:read",
  "promotions:read",
  "checks:read",
  "current_accounts:read",
  "service_charges:read",
] as const

export const DOCK_CREATE = DOCK_READ

export const DOCK_UPDATE = DOCK_READ

export const DOCK_DELETE = DOCK_READ
