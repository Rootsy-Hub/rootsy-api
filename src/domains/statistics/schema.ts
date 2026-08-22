import { z } from "zod"

export const STATISTICS_SECTION_IDS = [
  "sales",
  "profitability",
  "products",
  "purchases",
  "inventory",
  "clients",
  "suppliers",
  "finance",
  "services",
  "manufacturing",
] as const

export type StatisticsSectionId = (typeof STATISTICS_SECTION_IDS)[number]

const isoDate = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim() ?? ""
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null
  })

export const PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "this_month",
  "last_month",
  "this_year",
  "custom",
] as const

export const sectionQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  prevFrom: isoDate,
  prevTo: isoDate,
  channel: z
    .string()
    .optional()
    .transform((v) => {
      const t = v?.trim() ?? ""
      return t.length > 0 ? t : null
    }),
  supplier: z
    .string()
    .optional()
    .transform((v) => {
      const t = v?.trim() ?? ""
      return t.length > 0 ? t : null
    }),
})

export type SectionQuery = z.infer<typeof sectionQuerySchema>

export type StatisticsCompareMetric = {
  id: string
  label: string
  value: number
  previousValue: number
  deltaPercent: number | null
  deltaPoints: number | null
  format: "money" | "number" | "percent"
  hint?: string
}

export type StatisticsEvolutionPoint = {
  label: string
  value: number
  count?: number
  profit?: number
}

export type StatisticsHourlyHeatmap = {
  days: { key: string; label: string }[]
  hours: { slot: number; label: string }[]
  cells: { dayKey: string; hourSlot: number; value: number }[]
  maxValue: number
}

export type StatisticsSegment = {
  label: string
  value: number
  percent: number
  id?: string
}

export type StatisticsRankRow = {
  rank: number
  id?: string
  label: string
  value: number
  secondaryLabel?: string
  secondaryValue?: number
  secondaryFormat?: "money" | "number"
}

export type StatisticsProductTrendOption = {
  key: string
  label: string
}

export type StatisticsSunburstNode = {
  id: string
  label: string
  value: number
  children?: StatisticsSunburstNode[]
}

export type StatisticsWaterfallStep = {
  id: string
  label: string
  kind: "increase" | "decrease" | "subtotal" | "total"
  amount: number
}

export type StatisticsSectionData = {
  sectionId: StatisticsSectionId
  title: string
  description: string
  operationalDayCloseTime?: string
  comparison: StatisticsCompareMetric[]
  evolution: StatisticsEvolutionPoint[]
  hourlyEvolution: StatisticsEvolutionPoint[]
  hourlyHeatmap: StatisticsHourlyHeatmap
  segments: StatisticsSegment[]
  rankings: StatisticsRankRow[]
  productSalesRankings?: StatisticsRankRow[]
  productTrendOptions?: StatisticsProductTrendOption[]
  productTrendByKey?: Record<string, StatisticsEvolutionPoint[]>
  defaultProductTrendKey?: string | null
  resultWaterfall?: StatisticsWaterfallStep[]
  costDistribution?: StatisticsSegment[]
  purchaseDistribution?: StatisticsSegment[]
  categoryProfitDistribution?: StatisticsSegment[]
  categorySalesDistribution?: StatisticsSegment[]
  categoryTrendOptions?: StatisticsProductTrendOption[]
  categoryTrendByKey?: Record<string, StatisticsEvolutionPoint[]>
  defaultCategoryTrendKey?: string | null
  stockLevelDistribution?: StatisticsSegment[]
  inventoryValueSunburst?: StatisticsSunburstNode | null
  clientTrendOptions?: StatisticsProductTrendOption[]
  clientTrendByKey?: Record<string, StatisticsEvolutionPoint[]>
  defaultClientTrendKey?: string | null
  clientTopArticlesByKey?: Record<string, StatisticsRankRow[]>
  clientTopCategoriesByKey?: Record<string, StatisticsRankRow[]>
  supplierTrendOptions?: StatisticsProductTrendOption[]
  supplierTrendByKey?: Record<string, StatisticsEvolutionPoint[]>
  defaultSupplierTrendKey?: string | null
  supplierTopArticlesByKey?: Record<string, StatisticsRankRow[]>
  supplierTopCategoriesByKey?: Record<string, StatisticsRankRow[]>
  efficiencyRatios?: StatisticsCompareMetric[]
  commitmentMetrics?: StatisticsCompareMetric[]
  unavailable: string[]
}

export function emptyHeatmap(): StatisticsHourlyHeatmap {
  return { days: [], hours: [], cells: [], maxValue: 0 }
}

export const COMING_SOON_UNAVAILABLE: Partial<
  Record<StatisticsSectionId, string[]>
> = {
  services: [
    "Servicios vendidos",
    "Servicios activos / vencidos",
    "Tipos de servicio",
    "Evolución de facturación",
  ],
  manufacturing: [
    "Cantidad fabricada",
    "Costos de producción",
    "Consumo de insumos",
    "Órdenes por producto",
  ],
}

export function placeholderSection(
  sectionId: StatisticsSectionId,
  title: string,
  description = "",
): StatisticsSectionData {
  const data = emptySection(sectionId, title, description)
  data.unavailable = COMING_SOON_UNAVAILABLE[sectionId] ?? ["Datos no disponibles"]
  return data
}

export function emptySection(
  sectionId: StatisticsSectionId,
  title: string,
  description = "",
): StatisticsSectionData {
  return {
    sectionId,
    title,
    description,
    comparison: [],
    evolution: [],
    hourlyEvolution: [],
    hourlyHeatmap: emptyHeatmap(),
    segments: [],
    rankings: [],
    unavailable: [],
  }
}
