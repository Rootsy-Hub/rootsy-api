export function parseQty(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 1e6) / 1e6
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}
