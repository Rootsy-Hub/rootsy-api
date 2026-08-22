import {
  isServiceBillingPeriod,
  isServiceDiscountMode,
  type ServiceBillingPeriod,
  type ServiceDiscountMode,
} from "../services/catalog.js"

export type { ServiceBillingPeriod, ServiceDiscountMode }

export const SERVICE_CHARGE_BILLING_SCOPES = [
  "one_period",
  "multi_period",
  "subscription",
] as const

export type ServiceChargeBillingScope =
  (typeof SERVICE_CHARGE_BILLING_SCOPES)[number]

export const SERVICE_CHARGE_PAYMENT_MODES = ["one_time", "subscription"] as const

export type ServiceChargePaymentMode =
  (typeof SERVICE_CHARGE_PAYMENT_MODES)[number]

export const SERVICE_CHARGE_STORED_STATUSES = [
  "pending",
  "partial",
  "paid",
  "cancelled",
] as const

export type ServiceChargeStoredStatus =
  (typeof SERVICE_CHARGE_STORED_STATUSES)[number]

export type ServiceChargeEffectiveStatus =
  | ServiceChargeStoredStatus
  | "overdue"

export function isServiceChargeBillingScope(
  v: unknown,
): v is ServiceChargeBillingScope {
  return (
    typeof v === "string" &&
    (SERVICE_CHARGE_BILLING_SCOPES as readonly string[]).includes(v)
  )
}

export function roundServiceChargeMoney(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

function formatIsoDateOnly(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function todayIsoDateOnly(): string {
  return formatIsoDateOnly(new Date())
}

export function resolveServiceChargeEffectiveStatus(input: {
  storedStatus: ServiceChargeStoredStatus
  cancelledAt: string | null
  amount: number
  paidTotal: number
  dueDate: string
  today?: string
}): ServiceChargeEffectiveStatus {
  if (input.storedStatus === "cancelled" || input.cancelledAt) {
    return "cancelled"
  }
  const balance = roundServiceChargeMoney(input.amount - input.paidTotal)
  if (balance <= 0) return "paid"
  const today = input.today ?? todayIsoDateOnly()
  const isOverdue = input.dueDate < today
  if (isOverdue) return "overdue"
  if (input.paidTotal > 0 || input.storedStatus === "partial") return "partial"
  return "pending"
}

export function billingPeriodDisplayForCharge(
  billingPeriod: ServiceBillingPeriod,
  billingPeriodLabel: string | null,
  periodStart: string | null,
  periodEnd: string | null,
  sequenceIndex: number,
  periodCount: number,
): string {
  const range =
    periodStart && periodEnd
      ? periodStart === periodEnd
        ? periodStart
        : `${periodStart} → ${periodEnd}`
      : null
  if (periodCount > 1) {
    return `Período ${sequenceIndex + 1}/${periodCount}${range ? ` · ${range}` : ""}`
  }
  if (range) return range
  if (billingPeriod === "custom" && billingPeriodLabel?.trim()) {
    return billingPeriodLabel.trim()
  }
  return billingPeriod
}

export { isServiceBillingPeriod, isServiceDiscountMode }
