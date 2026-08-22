export type TreasuryAccountKind =
  | "cash"
  | "bank"
  | "wallet"
  | "card_payable"
  | "check_receivable"
  | "check_payable"
  | "other"

const KINDS: TreasuryAccountKind[] = [
  "cash",
  "bank",
  "wallet",
  "card_payable",
  "check_receivable",
  "check_payable",
  "other",
]

export function parseTreasuryKind(v: unknown): TreasuryAccountKind {
  const k = String(v ?? "other")
  return KINDS.includes(k as TreasuryAccountKind)
    ? (k as TreasuryAccountKind)
    : "other"
}

const MOTHER_PREFIXES = ["1.1.1.01.", "1.1.1.02.", "1.1.1.04."] as const

export function isMotherTreasuryAccount(chartAccountCode: string): boolean {
  const code = chartAccountCode.trim()
  if (!code) return false
  return MOTHER_PREFIXES.some((prefix) => code.startsWith(prefix))
}

export function isSettlementReceivableChartCode(chartAccountCode: string): boolean {
  const code = chartAccountCode.trim()
  return code.startsWith("1.1.1.03.") && code !== "1.1.1.03"
}

export function isCardPayableChartCode(chartAccountCode: string): boolean {
  const code = chartAccountCode.trim()
  return code.startsWith("2.1.1.03.") && code !== "2.1.1.03"
}

export const TREASURY_KIND_PARENT_CHART_CODE: Record<TreasuryAccountKind, string> =
  {
    cash: "1.1.1.01",
    bank: "1.1.1.02",
    wallet: "1.1.1.04",
    card_payable: "2.1.1.03",
    check_receivable: "1.1.2.02",
    check_payable: "2.1.1.02",
    other: "1.1.1.04",
  }

export const TREASURY_POS_PARENT_CHART_CODE = "1.1.1.03"
export const TREASURY_CARD_PAYABLE_PARENT_CHART_CODE = "2.1.1.03"

export function compareTreasuryChartAccountCodes(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}
