export const CHART_MERCADERIAS_CODES = [
  "1.1.3.01",
  "1.1.3.02",
  "1.1.3.03",
] as const

export const CHART_COSTO_VENTAS_CODES = ["5.1.1.01"] as const

export const CHART_IVA_PAGAR_CODES = ["2.1.2.01"] as const

export const CHART_CUENTAS_POR_COBRAR_CODES = ["1.1.2.01"] as const

export const CHART_VENTAS_POS_CODES = ["4.1.1.01"] as const

export const CHART_VENTAS_MESAS_CODES = ["4.1.1.03", "4.1.1.01"] as const

export const CHART_VENTAS_MOSTRADOR_CODES = ["4.1.1.04", "4.1.1.01"] as const

export function chartVentasCodesForChannel(
  channel: "pos" | "table" | "counter",
): readonly string[] {
  if (channel === "table") return CHART_VENTAS_MESAS_CODES
  if (channel === "counter") return CHART_VENTAS_MOSTRADOR_CODES
  return CHART_VENTAS_POS_CODES
}

export const PAYMENT_KIND_ACCOUNT_FALLBACK = {
  cash: ["1.1.1.01"],
  transfer: ["1.1.1.02", "1.1.1.04"],
  card_debit: ["1.1.1.03"],
  card_credit: ["1.1.1.03"],
  check: ["1.1.2.02", "2.1.1.02"],
  other: ["1.1.1.02", "1.1.1.04"],
} as const
