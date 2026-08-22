export type OperationPaymentKind =
  | "cash"
  | "card_debit"
  | "card_credit"
  | "transfer"
  | "check"
  | "other"

export const OPERATION_PAYMENT_KINDS: {
  value: OperationPaymentKind
  label: string
}[] = [
  { value: "cash", label: "Efectivo" },
  { value: "card_debit", label: "Tarjeta débito" },
  { value: "card_credit", label: "Tarjeta crédito" },
  { value: "transfer", label: "Transferencia" },
  { value: "check", label: "Cheque" },
  { value: "other", label: "Otro" },
]

export function operationPaymentKindLabel(
  kind: OperationPaymentKind | string,
): string {
  return (
    OPERATION_PAYMENT_KINDS.find((k) => k.value === kind)?.label ??
    String(kind || "—")
  )
}

export const CLIENT_ACCOUNT_PAYMENT_LABEL = "Cuenta corriente del cliente"
export const SUPPLIER_ACCOUNT_PAYMENT_LABEL = "Cuenta corriente del proveedor"

export function formatOperationPaymentMethods(
  payments: ReadonlyArray<{ methodName: string }>,
): string {
  const names = payments
    .map((p) => p.methodName.trim())
    .filter((name) => name.length > 0 && name !== "—")
  if (names.length === 0) return "—"
  return [...new Set(names)].join(" · ")
}

export function resolveOperationPaymentMethodLabel(args: {
  payments: ReadonlyArray<{ methodName: string }>
  onClientAccount?: boolean
  onSupplierAccount?: boolean
}): string {
  const fromPayments = formatOperationPaymentMethods(args.payments)
  if (fromPayments !== "—") return fromPayments
  if (args.onClientAccount) return CLIENT_ACCOUNT_PAYMENT_LABEL
  if (args.onSupplierAccount) return SUPPLIER_ACCOUNT_PAYMENT_LABEL
  return "—"
}
