export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export function parseMoney(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return roundMoney(n)
}
