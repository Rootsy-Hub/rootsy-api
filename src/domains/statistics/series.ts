import { operationalDayKey } from "../operations/operationalDay.js"
import { addCalendarDays } from "../operations/timezone.js"
import { parseMoney, roundMoney } from "../reports/money.js"
import { dayLabel } from "./compare.js"
import type { SlimSale } from "./loaders.js"
import type {
  StatisticsEvolutionPoint,
  StatisticsHourlyHeatmap,
} from "./schema.js"

function closeTimeToMinutes(closeTime: string): number {
  const match = closeTime.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return 0
  return Number(match[1]) * 60 + Number(match[2])
}

function timestampToLocalMinutes(isoTimestamp: string, timeZone: string): number {
  const instant = new Date(isoTimestamp)
  if (Number.isNaN(instant.getTime())) return 0
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(instant)
  const hourRaw = Number(parts.find((p) => p.type === "hour")?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0)
  return (hourRaw === 24 ? 0 : hourRaw) * 60 + minute
}

function operationalHourSlotIndex(
  isoTimestamp: string,
  timeZone: string,
  closeTime: string,
): number {
  const localMinutes = timestampToLocalMinutes(isoTimestamp, timeZone)
  const closeMinutes = closeTimeToMinutes(closeTime)
  if (closeMinutes === 0) return Math.floor(localMinutes / 60) % 24
  const offsetFromOpen = (localMinutes - closeMinutes + 24 * 60) % (24 * 60)
  return Math.floor(offsetFromOpen / 60)
}

function operationalHourSlotLabel(slotIndex: number, closeTime: string): string {
  const closeMinutes = closeTimeToMinutes(closeTime)
  const clockHour = Math.floor((closeMinutes + slotIndex * 60) / 60) % 24
  return `${String(clockHour).padStart(2, "0")}h`
}

const HEATMAP_WEEKDAYS = [
  { key: "1", label: "Lun" },
  { key: "2", label: "Mar" },
  { key: "3", label: "Mié" },
  { key: "4", label: "Jue" },
  { key: "5", label: "Vie" },
  { key: "6", label: "Sáb" },
  { key: "7", label: "Dom" },
]

function isoWeekday(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  const jsDay = utc.getUTCDay()
  return jsDay === 0 ? 7 : jsDay
}

export function buildDailySaleEvolution(
  sales: SlimSale[],
  from: string | null,
  to: string | null,
  timeZone: string,
  closeTime: string,
): StatisticsEvolutionPoint[] {
  const buckets = new Map<string, { total: number; count: number }>()
  for (const sale of sales) {
    const day = operationalDayKey(sale.soldAt, timeZone, closeTime)
    const prev = buckets.get(day) ?? { total: 0, count: 0 }
    prev.total += sale.total
    prev.count += 1
    buckets.set(day, prev)
  }
  const toPoint = (day: string): StatisticsEvolutionPoint => {
    const bucket = buckets.get(day) ?? { total: 0, count: 0 }
    return {
      label: dayLabel(day),
      value: roundMoney(bucket.total),
      count: bucket.count,
    }
  }
  if (!from || !to) {
    return [...buckets.keys()].sort().map(toPoint)
  }
  const points: StatisticsEvolutionPoint[] = []
  let cursor = from
  while (cursor <= to) {
    points.push(toPoint(cursor))
    cursor = addCalendarDays(cursor, 1)
  }
  return points
}

export function buildHourlySalesViews(
  sales: SlimSale[],
  from: string | null,
  to: string | null,
  timeZone: string,
  closeTime: string,
): {
  hourlyEvolution: StatisticsEvolutionPoint[]
  hourlyHeatmap: StatisticsHourlyHeatmap
} {
  const hourBuckets = new Map<number, number>()
  const cells = new Map<string, number>()
  for (const sale of sales) {
    const slot = operationalHourSlotIndex(sale.soldAt, timeZone, closeTime)
    hourBuckets.set(slot, (hourBuckets.get(slot) ?? 0) + sale.total)
    const day = operationalDayKey(sale.soldAt, timeZone, closeTime)
    const weekday = String(isoWeekday(day))
    const key = `${weekday}:${slot}`
    cells.set(key, (cells.get(key) ?? 0) + sale.total)
  }

  const hourlyEvolution = Array.from({ length: 24 }, (_, slot) => ({
    label: operationalHourSlotLabel(slot, closeTime),
    value: roundMoney(hourBuckets.get(slot) ?? 0),
  }))

  const hours = Array.from({ length: 24 }, (_, slot) => ({
    slot,
    label: operationalHourSlotLabel(slot, closeTime),
  }))
  const heatmapCells: StatisticsHourlyHeatmap["cells"] = []
  let maxValue = 0
  for (const day of HEATMAP_WEEKDAYS) {
    for (const hour of hours) {
      const value = roundMoney(cells.get(`${day.key}:${hour.slot}`) ?? 0)
      if (value > 0) {
        heatmapCells.push({ dayKey: day.key, hourSlot: hour.slot, value })
      }
      if (value > maxValue) maxValue = value
    }
  }

  return {
    hourlyEvolution,
    hourlyHeatmap: {
      days: HEATMAP_WEEKDAYS,
      hours,
      cells: heatmapCells,
      maxValue,
    },
  }
}

export function buildDailyPurchaseEvolution(
  purchases: Array<{ occurredAt: string; total: number }>,
  from: string | null,
  to: string | null,
  timeZone: string,
  closeTime: string,
): StatisticsEvolutionPoint[] {
  const buckets = new Map<string, { total: number; count: number }>()
  for (const purchase of purchases) {
    const day = operationalDayKey(purchase.occurredAt, timeZone, closeTime)
    const prev = buckets.get(day) ?? { total: 0, count: 0 }
    prev.total += purchase.total
    prev.count += 1
    buckets.set(day, prev)
  }
  const toPoint = (day: string): StatisticsEvolutionPoint => {
    const bucket = buckets.get(day) ?? { total: 0, count: 0 }
    return {
      label: dayLabel(day),
      value: roundMoney(bucket.total),
      count: bucket.count,
    }
  }
  if (!from || !to) {
    return [...buckets.keys()].sort().map(toPoint)
  }
  return fillDailyPoints(from, to, toPoint)
}

export function fillDailyPoints(
  from: string | null,
  to: string | null,
  valueForDay: (day: string) => StatisticsEvolutionPoint,
): StatisticsEvolutionPoint[] {
  if (!from || !to) return []
  const points: StatisticsEvolutionPoint[] = []
  let cursor = from
  while (cursor <= to) {
    points.push(valueForDay(cursor))
    cursor = addCalendarDays(cursor, 1)
  }
  return points
}

export function parseQty(value: unknown): number {
  return parseMoney(value)
}
