import type {
  CurrentAccountAgingBucket,
  CurrentAccountAgingTotals,
  CurrentAccountDirection,
  CurrentAccountDocumentKind,
  OperationPaymentKind,
} from "./schema.js"

export const CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS = 30

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export function currentAccountDocumentKindForDirection(
  direction: CurrentAccountDirection,
): CurrentAccountDocumentKind {
  return direction === "payable" ? "purchase" : "sale"
}

export function currentAccountOpenAmount(total: number, allocated: number): number {
  return Math.max(0, roundMoney(total) - roundMoney(allocated))
}

export function currentAccountIsOpen(total: number, allocated: number): boolean {
  return currentAccountOpenAmount(total, allocated) > 0.009
}

export function currentAccountDocumentLabel(
  kind: CurrentAccountDocumentKind,
  documentNumber: string,
): string {
  const number = documentNumber.trim()
  if (kind === "purchase") {
    return number ? `Compra ${number}` : "Compra"
  }
  return number ? `Venta ${number}` : "Venta"
}

function isoDateMs(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const ms = Date.parse(`${iso}T12:00:00`)
  return Number.isFinite(ms) ? ms : null
}

export function currentAccountDaysOverdue(dueDate: string, today: string): number {
  const due = isoDateMs(dueDate)
  const now = isoDateMs(today)
  if (due == null || now == null) return 0
  return Math.floor((now - due) / 86_400_000)
}

export function currentAccountAgingBucket(
  dueDate: string,
  today: string,
): CurrentAccountAgingBucket {
  const days = currentAccountDaysOverdue(dueDate, today)
  if (days <= 0) return "current"
  if (days <= 30) return "d1_30"
  if (days <= 60) return "d31_60"
  return "d61_plus"
}

export function emptyCurrentAccountAgingTotals(): CurrentAccountAgingTotals {
  return { current: 0, d1_30: 0, d31_60: 0, d61_plus: 0 }
}

export function addCurrentAccountAgingAmount(
  totals: CurrentAccountAgingTotals,
  bucket: CurrentAccountAgingBucket,
  amount: number,
): CurrentAccountAgingTotals {
  const next = { ...totals }
  next[bucket] = roundMoney(next[bucket] + amount)
  return next
}

export function normalizeCurrentAccountTermDays(raw: unknown): number {
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n) || n < 1) return CURRENT_ACCOUNT_SALE_DEFAULT_DUE_DAYS
  return Math.min(365, n)
}

export function normalizeCurrentAccountCreditLimit(raw: unknown): number | null {
  if (raw == null || raw === "") return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0.009) return null
  return roundMoney(n)
}

export function currentAccountAvailableCredit(
  creditLimit: number | null,
  balance: number,
): number | null {
  if (creditLimit == null) return null
  return roundMoney(Math.max(0, creditLimit - balance))
}

const PAYMENT_KIND_LABELS: Record<OperationPaymentKind, string> = {
  cash: "Efectivo",
  card_debit: "Tarjeta débito",
  card_credit: "Tarjeta crédito",
  transfer: "Transferencia",
  check: "Cheque",
  other: "Otro",
}

export function isValidOperationPaymentKind(
  kind: string,
): kind is OperationPaymentKind {
  return kind in PAYMENT_KIND_LABELS
}

export function operationPaymentKindLabel(kind: string): string {
  return isValidOperationPaymentKind(kind) ? PAYMENT_KIND_LABELS[kind] : String(kind || "—")
}

export function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}
