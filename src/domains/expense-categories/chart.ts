export const EXPENSE_FAMILIES = [
  "administracion",
  "comercializacion",
  "financiera",
] as const

export type ExpenseFamily = (typeof EXPENSE_FAMILIES)[number]

export const EXPENSE_FAMILY_PREFIX: Record<ExpenseFamily, string> = {
  administracion: "6.1.1",
  comercializacion: "6.2.1",
  financiera: "6.3.1",
}

export function nextExpenseChartCode(
  prefix: string,
  existingCodes: readonly string[],
): string {
  const used = new Set<number>()
  const needle = `${prefix}.`
  for (const code of existingCodes) {
    if (!code.startsWith(needle)) continue
    const n = Number.parseInt(code.slice(needle.length), 10)
    if (Number.isFinite(n)) used.add(n)
  }
  let next = 1
  while (used.has(next) || (prefix === "6.2.1" && next === 99)) {
    next += 1
  }
  return `${prefix}.${String(next).padStart(2, "0")}`
}

export function sortOrderFromChartCode(prefix: string, code: string): number {
  const suffix = Number.parseInt(code.slice(prefix.length + 1), 10)
  return Number.isFinite(suffix) ? suffix : 1000
}

export const EXPENSE_SYSTEM_VIEW_ONLY_CODES = [
  "6.1.1.03",
  "6.1.1.04",
  "6.1.1.05",
  "6.2.1.03",
  "6.3.1.01",
] as const

const EXPENSE_DEFAULT_KIND_BY_CODE: Record<string, string> = {
  "6.1.1.01": "fijo",
  "6.1.1.02": "fijo",
  "6.1.1.03": "otro",
  "6.1.1.04": "otro",
  "6.1.1.05": "otro",
  "6.2.1.01": "variable",
  "6.2.1.02": "variable",
  "6.2.1.03": "otro",
  "6.2.1.99": "variable",
  "6.3.1.01": "otro",
}

export function isExpenseSystemViewOnlyCode(code: string): boolean {
  return (EXPENSE_SYSTEM_VIEW_ONLY_CODES as readonly string[]).includes(
    code.trim(),
  )
}

export function isExpenseDefaultChartCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    EXPENSE_DEFAULT_KIND_BY_CODE,
    code.trim(),
  )
}
