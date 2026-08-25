import {
  type ComandaSendKind,
  type ComandaSourceKind,
  type ComandaStatus,
  type ComandaTicket,
} from "./schema.js"

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

export type MutateFail = {
  success: false
  error: string
  status: 400 | 404 | 409 | 500
}

export type ComandaDbRow = {
  id: string
  station_id: string
  status: string
  source_kind: string
  source_id: string
  cart_line_id: string
  recipe_id: string | null
  recipe_name: string
  quantity: number
  comment: string
  origin_label: string
  customer_name: string
  created_at: string
  updated_at: string
  status_changed_at: string
  sent_at: string | null
  preparing_at: string | null
  ready_at: string | null
  delivered_at: string | null
  send_id?: string | null
  comanda_sends?:
    | { comment?: string | null; kind?: string | null }
    | { comment?: string | null; kind?: string | null }[]
    | null
}

function isComandaStatus(value: string): value is ComandaStatus {
  return (
    value === "pending" ||
    value === "sent" ||
    value === "preparing" ||
    value === "ready" ||
    value === "delivered" ||
    value === "voided"
  )
}

function parseSendKind(value: unknown): ComandaSendKind {
  return value === "void" ? "void" : "order"
}

export function mapComandaRow(row: ComandaDbRow): ComandaTicket {
  const sendRel = row.comanda_sends
  const send = Array.isArray(sendRel) ? sendRel[0] : sendRel
  const sourceKind: ComandaSourceKind =
    row.source_kind === "counter" ? "counter" : "table"
  return {
    id: String(row.id),
    stationId: String(row.station_id),
    status: isComandaStatus(row.status) ? row.status : "sent",
    sourceKind,
    sourceId: String(row.source_id),
    cartLineId: String(row.cart_line_id),
    recipeId: row.recipe_id ? String(row.recipe_id) : null,
    recipeName: String(row.recipe_name ?? ""),
    quantity: Math.max(1, Number(row.quantity) || 1),
    comment: String(row.comment ?? ""),
    originLabel: String(row.origin_label ?? ""),
    customerName: String(row.customer_name ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    statusChangedAt: String(row.status_changed_at),
    sentAt: row.sent_at ? String(row.sent_at) : null,
    preparingAt: row.preparing_at ? String(row.preparing_at) : null,
    readyAt: row.ready_at ? String(row.ready_at) : null,
    deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    sendId: row.send_id ? String(row.send_id) : null,
    sendKind: parseSendKind(send?.kind),
    sendComment: send?.comment ? String(send.comment) : "",
  }
}

export function canMoveComandaTo(from: ComandaStatus, to: ComandaStatus): boolean {
  if (from === to) return false
  const dragable =
    from === "sent" ||
    from === "preparing" ||
    from === "ready" ||
    from === "delivered"
  const dragableTo =
    to === "sent" ||
    to === "preparing" ||
    to === "ready" ||
    to === "delivered"
  return dragable && dragableTo
}

export function timestampsForStatusChange(
  current: {
    sentAt: string | null
    preparingAt: string | null
    readyAt: string | null
    deliveredAt: string | null
  },
  next: ComandaStatus,
  now: string,
): Record<string, string> {
  const patch: Record<string, string> = {
    status: next,
    status_changed_at: now,
  }
  if (next === "sent" && !current.sentAt) patch.sent_at = now
  if (next === "preparing" && !current.preparingAt) patch.preparing_at = now
  if (next === "ready" && !current.readyAt) patch.ready_at = now
  if (next === "delivered" && !current.deliveredAt) patch.delivered_at = now
  return patch
}

export function resolveSendQuantity(requested: unknown, pendingQty: number): number {
  const n = Math.round(Number(requested))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(pendingQty, n)
}
