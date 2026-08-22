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
