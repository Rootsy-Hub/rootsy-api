/** Keys reales de POP_PERMS. OR por verbo. */

export const ARTICLE_READ = ["articles:read"] as const

/** Listado de artículos en operar (Vender / Mesas / Mostrador). */
export const ARTICLE_LIST_READ = [
  "articles:read",
  "sale:read",
  "mesas:read",
  "mostrador:read",
] as const

export const ARTICLE_CREATE = ["articles:create"] as const

export const ARTICLE_UPDATE = ["articles:update"] as const

export const ARTICLE_DELETE = ["articles:delete"] as const
