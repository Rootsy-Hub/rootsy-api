import { z } from "zod"
import type { InventoryAttention } from "./stockLevels.js"

export type InventoryUnitStock = {
  unitOfMeasure: string
  quantity: number
  articleCount: number
}

export type InventoryMetrics = {
  articleCount: number
  articlesWithStock: number
  unitsInStock: number
  unitsByMeasure: InventoryUnitStock[]
  inventoryValue: number
  redCount: number
  negativeCount: number
  emptyCount: number
  belowMinCount: number
  overstockCount: number
  purchaseCount: number
  recommendationCount: number
}

export type InventoryArticleRow = {
  articleId: string
  name: string
  unitOfMeasure: string
  onHand: number
  minLevel: number | null
  unitCost: number
  inventoryValue: number
  attention: InventoryAttention
  suggestedMin: number | null
  suggestedMax: number | null
  qtyToBuy: number
}

export type InventoryLocationSlim = {
  id: string
  name: string
  isDefault: boolean
  isSellable: boolean
}

export type InventoryLocationRow = {
  id: string
  name: string
  isDefault: boolean
  isSellable: boolean
  articleCount: number
  inventoryValue: number
  canArchive: boolean
}

export type InventoryExpirySummary = {
  expiredCount: number
  soonCount: number
  total: number
}

export type InventorySummaryData = {
  metrics: InventoryMetrics
  locations: InventoryLocationSlim[]
  expiry: InventoryExpirySummary
}

export type InventoryMovementRow = {
  id: string
  articleId: string
  articleName: string
  quantityDelta: number
  movementType: string
  note: string
  createdAt: string
  createdBy: string | null
}

export type InventoryCostLayerRow = {
  id: string
  articleId: string
  articleName: string
  sourceMovementId: string | null
  quantityReceived: number
  quantityRemaining: number
  unitCost: number
  receivedAt: string
  expiresAt: string | null
  locationId: string
  locationName: string
  unitOfMeasure: string
}

export type InventoryLayerAllocationRow = {
  id: string
  layerId: string
  articleId: string
  articleName: string
  inventoryMovementId: string
  movementType: string
  quantity: number
  unitCost: number
  lineCost: number
  createdAt: string
}

export type InventoryLedgerData = {
  costLayers: InventoryCostLayerRow[]
  layerAllocations: InventoryLayerAllocationRow[]
}

export type InventoryArticleSearchHit = {
  id: string
  name: string
  unitOfMeasure: string
  sku: string | null
  barcode: string | null
}

export const searchArticlesQuerySchema = z.object({
  q: z.string().trim().max(80).optional().default(""),
})

export const INVENTORY_ROW_VIEWS = [
  "pantry",
  "red",
  "overstock",
  "purchase",
  "recommend",
] as const

export const listRowsQuerySchema = z.object({
  view: z.enum(INVENTORY_ROW_VIEWS).optional().default("pantry"),
  q: z.string().trim().max(80).optional().default(""),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(25),
  attention: z.enum(["negative", "empty", "below_min"]).optional(),
})

export type ListRowsQuery = z.infer<typeof listRowsQuerySchema>

export type InventoryRowsData = {
  rows: InventoryArticleRow[]
  total: number
  page: number
  pageSize: number
}

export const listMovementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(25),
})

export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>

export type InventoryMovementsData = {
  movements: InventoryMovementRow[]
  page: number
  pageSize: number
  hasMore: boolean
}

export const listLedgerQuerySchema = z.object({
  kind: z.enum(["layers", "allocations"]),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(25),
})

export type ListLedgerQuery = z.infer<typeof listLedgerQuerySchema>

export type InventoryLedgerLayersData = {
  costLayers: InventoryCostLayerRow[]
  page: number
  pageSize: number
  hasMore: boolean
}

export type InventoryLedgerAllocationsData = {
  layerAllocations: InventoryLayerAllocationRow[]
  page: number
  pageSize: number
  hasMore: boolean
}

export const listExpiryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(25),
  q: z.string().trim().max(80).optional().default(""),
  filter: z.enum(["alert", "dated", "none"]).optional().default("alert"),
})

export type ListExpiryQuery = z.infer<typeof listExpiryQuerySchema>

export type InventoryExpiryData = {
  costLayers: InventoryCostLayerRow[]
  page: number
  pageSize: number
  hasMore: boolean
}

export const balanceQuerySchema = z.object({
  articleId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
})

export const createAdjustmentBodySchema = z.object({
  articleId: z.string().uuid(),
  quantityDelta: z.number(),
  note: z.string().trim().min(1).max(500),
  locationId: z.string().uuid().optional(),
  expiresAt: z.string().nullable().optional(),
})

export const applyMinStockBodySchema = z.object({
  articleIds: z.array(z.string().uuid()).optional(),
})

export const createLocationBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
})

export const renameLocationBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
})

export const transferBodySchema = z.object({
  articleId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  quantity: z.number(),
})

export const setExpiryBodySchema = z.object({
  expiresAt: z.string().nullable(),
  quantity: z.number().optional(),
})

export type CreateAdjustmentBody = z.infer<typeof createAdjustmentBodySchema>
export type ApplyMinStockBody = z.infer<typeof applyMinStockBodySchema>
export type TransferBody = z.infer<typeof transferBodySchema>
export type SetExpiryBody = z.infer<typeof setExpiryBodySchema>
