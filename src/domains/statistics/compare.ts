import { roundMoney } from "../reports/money.js"
import type { StatisticsCompareMetric } from "./schema.js"

export function summaryDeltaPercent(
  current: number,
  previous: number,
): number | null {
  if (previous === 0) return current === 0 ? 0 : null
  return roundMoney(((current - previous) / Math.abs(previous)) * 100)
}

export function compareMetric(
  id: string,
  label: string,
  value: number,
  previousValue: number,
  format: StatisticsCompareMetric["format"],
  hint?: string,
): StatisticsCompareMetric {
  return {
    id,
    label,
    value,
    previousValue,
    deltaPercent: summaryDeltaPercent(value, previousValue),
    deltaPoints: null,
    format,
    hint,
  }
}

export function comparePercentMetric(
  id: string,
  label: string,
  value: number,
  previousValue: number,
): StatisticsCompareMetric {
  return {
    id,
    label,
    value,
    previousValue,
    deltaPercent: null,
    deltaPoints: roundMoney(value - previousValue),
    format: "percent",
  }
}

export function ratioOverSales(value: number, ingresos: number): number {
  return ingresos > 0 ? roundMoney((value / ingresos) * 100) : 0
}

export function buildSegments(
  totals: Map<string, number>,
  limit = 8,
): { label: string; value: number; percent: number }[] {
  const rows = [...totals.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
  const sliced = rows.slice(0, limit)
  const grand = sliced.reduce((sum, [, value]) => sum + value, 0)
  return sliced.map(([label, value]) => ({
    label,
    value: roundMoney(value),
    percent: grand > 0 ? roundMoney((value / grand) * 100) : 0,
  }))
}

export function buildRankings(
  totals: Map<string, number>,
  counts?: Map<string, number>,
  limit = 8,
): {
  rank: number
  label: string
  value: number
  secondaryLabel?: string
  secondaryValue?: number
  secondaryFormat?: "money" | "number"
}[] {
  return [...totals.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value], index) => ({
      rank: index + 1,
      label,
      value: roundMoney(value),
      ...(counts
        ? {
            secondaryLabel: "Operaciones",
            secondaryValue: counts.get(label) ?? 0,
            secondaryFormat: "number" as const,
          }
        : {}),
    }))
}

export function saleChannelLabel(channel: string | null | undefined): string {
  if (channel === "table") return "Mesas"
  if (channel === "counter") return "Mostrador"
  return "POS"
}

export function dayLabel(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}`
}
