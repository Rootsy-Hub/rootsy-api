export function monthBoundsISO(
  year: number,
  month1: number,
): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0")
  const start = `${year}-${pad(month1)}-01`
  const last = new Date(year, month1, 0)
  const y = last.getFullYear()
  const m = last.getMonth() + 1
  const d = last.getDate()
  const end = `${y}-${pad(m)}-${pad(d)}`
  return { start, end }
}

export function expenseDateBelongsToMonth(
  expenseDateISO: string,
  year: number,
  month1: number,
): boolean {
  const t = expenseDateISO.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
  const { start, end } = monthBoundsISO(year, month1)
  return t >= start && t <= end
}
