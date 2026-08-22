import type { ExpenseCategoryKind, OperationPaymentKind } from "./schema.js"

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export function parseMoney(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return roundMoney(n)
}

export function parseExpenseCategoryKind(value: unknown): ExpenseCategoryKind {
  if (value === "variable" || value === "otro") return value
  return "fijo"
}

export function isValidOperationPaymentKind(
  kind: string,
): kind is OperationPaymentKind {
  return (
    kind === "cash" ||
    kind === "card_debit" ||
    kind === "card_credit" ||
    kind === "transfer" ||
    kind === "check" ||
    kind === "other"
  )
}

export function parseCheckoutCheckDetails(input: unknown):
  | {
      ok: true
      details: {
        checkNumber: string
        bankName: string
        issueDate: string
        dueDate: string
        partyName: string
        partyId: string
        notes: string
      }
    }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Completá los datos del cheque." }
  }
  const raw = input as Record<string, unknown>
  const checkNumber = String(raw.checkNumber ?? "").trim()
  if (!checkNumber) return { ok: false, error: "El número de cheque es obligatorio." }
  const bankName = String(raw.bankName ?? "").trim()
  if (!bankName) return { ok: false, error: "El banco es obligatorio." }
  const issueDate = String(raw.issueDate ?? "").trim()
  const dueDate = String(raw.dueDate ?? "").trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { ok: false, error: "Revisá las fechas de emisión y cobro." }
  }
  return {
    ok: true,
    details: {
      checkNumber,
      bankName,
      issueDate,
      dueDate,
      partyName: String(raw.partyName ?? "").trim(),
      partyId: String(raw.partyId ?? "").trim(),
      notes: String(raw.notes ?? "").trim(),
    },
  }
}
