import { z } from "zod"

export const MIN_DOCK_ITEMS = 1
export const MAX_DOCK_ITEMS = 8

/** IDs navegables del dock (alineados con menuCatalog de rootsy-web). */
export const DOCK_ITEM_IDS = [
  "home",
  "sale",
  "quotes",
  "purchase-orders",
  "mesas",
  "comandas",
  "mostrador",
  "operations",
  "purchases",
  "expenses",
  "suppliers",
  "invoices",
  "settings",
  "hr",
  "articles",
  "clients",
  "accounts",
  "printers",
  "cash-registers",
  "inventory",
  "recipes",
  "services",
  "cobrar-servicios",
  "promotions",
  "reports",
  "statistics",
  "checks",
  "current-accounts",
  "alerts",
  "chat",
  "manufacturing",
] as const

export type DockItemId = (typeof DOCK_ITEM_IDS)[number]

const DOCK_ITEM_ID_SET = new Set<string>(DOCK_ITEM_IDS)

export function parseDockItemIds(raw: unknown): DockItemId[] {
  if (!Array.isArray(raw)) return []
  const out: DockItemId[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const id = entry === "active-services" ? "operations" : String(entry ?? "")
    if (!id || seen.has(id) || !DOCK_ITEM_ID_SET.has(id)) continue
    seen.add(id)
    out.push(id as DockItemId)
    if (out.length >= MAX_DOCK_ITEMS) break
  }
  return out
}

export const createDockBodySchema = z.object({
  dockItemIds: z
    .array(z.string())
    .transform(parseDockItemIds)
    .refine((ids) => ids.length >= MIN_DOCK_ITEMS, {
      message: "El dock debe tener entre 1 y 8 accesos válidos.",
    }),
})

export const updateDockBodySchema = createDockBodySchema

export type DockRow = {
  popId: string
  userId: string
  dockItemIds: DockItemId[]
  createdAt: string
  updatedAt: string
}
