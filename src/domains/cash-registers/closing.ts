import { parseMoney, roundMoney } from "../reports/money.js"
import type { ClosingSnapshot } from "./schema.js"

export function parseClosingSnapshot(raw: unknown): ClosingSnapshot | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const cash = parseMoney(o.cash)
  const pm: Record<string, number> = {}
  const pms = o.payment_methods
  if (pms && typeof pms === "object" && !Array.isArray(pms)) {
    for (const [k, v] of Object.entries(pms as Record<string, unknown>)) {
      pm[k] = parseMoney(v)
    }
  }
  const treasuryLines: Record<string, number> = {}
  const tls = o.treasury_lines
  if (tls && typeof tls === "object" && !Array.isArray(tls)) {
    for (const [k, v] of Object.entries(tls as Record<string, unknown>)) {
      treasuryLines[k] = parseMoney(v)
    }
  }
  const note = typeof o.note === "string" ? o.note : null
  return {
    cash,
    payment_methods: Object.keys(pm).length > 0 ? pm : undefined,
    treasury_lines:
      Object.keys(treasuryLines).length > 0 ? treasuryLines : undefined,
    note: note ?? undefined,
  }
}

/** En el reporte de período no se cargan cobros por medio; el neto es cajón + líneas informadas. */
export function cashArqueoDifferenceFromSnapshot(
  openingCash: number,
  movementDeposits: number,
  movementWithdrawals: number,
  snapshot: ClosingSnapshot | null,
): number | null {
  if (!snapshot) return null
  const teorico = roundMoney(
    openingCash + movementDeposits - movementWithdrawals,
  )
  let net = roundMoney(snapshot.cash - teorico)
  const extra = snapshot.treasury_lines ?? snapshot.payment_methods ?? {}
  for (const [key, amount] of Object.entries(extra)) {
    if (!snapshot.treasury_lines && key === "cash") continue
    net = roundMoney(net + amount)
  }
  return net
}

export function sessionEfectivoTeorico(
  openingCash: number,
  movementDeposits: number,
  movementWithdrawals: number,
): number {
  return roundMoney(openingCash + movementDeposits - movementWithdrawals)
}
