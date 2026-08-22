import type {
  CheckDirection,
  CheckLifecycleAction,
  CheckSourceKind,
  CheckStatus,
  CheckTableRow,
} from "./schema.js"
import {
  CHECK_DIRECTIONS,
  CHECK_SOURCE_KINDS,
  CHECK_STATUSES,
} from "./schema.js"

export function isCheckDirection(value: string): value is CheckDirection {
  return (CHECK_DIRECTIONS as readonly string[]).includes(value)
}

export function isCheckStatus(value: string): value is CheckStatus {
  return (CHECK_STATUSES as readonly string[]).includes(value)
}

export function canApplyCheckLifecycleAction(
  status: CheckStatus,
  action: CheckLifecycleAction,
): boolean {
  if (action === "deposit") return status === "in_portfolio"
  if (action === "clear") return status === "deposited"
  if (action === "reject") {
    return status === "in_portfolio" || status === "deposited"
  }
  if (action === "void") return status === "in_portfolio"
  return false
}

export function lifecycleBlockedError(
  status: CheckStatus,
  action: CheckLifecycleAction,
): string | null {
  if (canApplyCheckLifecycleAction(status, action)) return null
  if (status === "cleared") return "Este cheque ya está acreditado."
  if (status === "rejected") return "Este cheque ya está rechazado."
  if (status === "voided") return "Este cheque está anulado."
  if (action === "deposit") return "Solo se puede depositar un cheque en cartera."
  if (action === "clear") return "Primero tenés que depositarlo."
  if (action === "void") return "Solo se puede anular un cheque en cartera."
  return "Esa acción no aplica a este cheque."
}

function relatedName(
  related: { name?: string } | { name?: string }[] | null | undefined,
): string {
  if (!related) return ""
  if (Array.isArray(related)) return String(related[0]?.name ?? "").trim()
  return String(related.name ?? "").trim()
}

export function partyNameFromRow(row: {
  direction: unknown
  drawer_name: unknown
  payee_name: unknown
  clients: unknown
  suppliers: unknown
}): string {
  const clientName = relatedName(
    row.clients as { name?: string } | { name?: string }[] | null,
  )
  const supplierName = relatedName(
    row.suppliers as { name?: string } | { name?: string }[] | null,
  )
  if (row.direction === "issued") {
    return String(supplierName || row.payee_name || "").trim()
  }
  return String(clientName || row.drawer_name || "").trim()
}

function asSourceKind(raw: unknown): CheckSourceKind {
  const value = String(raw ?? "manual")
  return (CHECK_SOURCE_KINDS as readonly string[]).includes(value)
    ? (value as CheckSourceKind)
    : "manual"
}

export function mapCheckTableRow(row: Record<string, unknown>): CheckTableRow {
  const direction = isCheckDirection(String(row.direction ?? ""))
    ? (row.direction as CheckDirection)
    : "received"
  const status = isCheckStatus(String(row.status ?? ""))
    ? (row.status as CheckStatus)
    : "in_portfolio"
  return {
    id: String(row.id),
    direction,
    checkNumber: String(row.check_number ?? ""),
    bankName: String(row.bank_name ?? ""),
    amount: Number(row.amount ?? 0) || 0,
    issueDate: String(row.issue_date ?? ""),
    dueDate: String(row.due_date ?? ""),
    status,
    partyName: partyNameFromRow(
      row as {
        direction: unknown
        drawer_name: unknown
        payee_name: unknown
        clients: unknown
        suppliers: unknown
      },
    ),
    sourceKind: asSourceKind(row.source_kind),
  }
}

export function parseMoneyInput(raw: string, fallback = 0): number {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  if (trimmed.includes(",")) {
    const normalized = trimmed.replace(/\./g, "").replace(",", ".")
    const n = Number.parseFloat(normalized)
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.round(n * 100) / 100
  }
  const digits = trimmed.replace(/\./g, "").replace(/\D/g, "")
  if (!digits) return fallback
  const n = Number.parseInt(digits, 10)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

export function escapeIlikeToken(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}
