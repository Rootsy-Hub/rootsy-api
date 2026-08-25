import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { applyWithAudit } from "../../audit/apply.js"
import type { AuditOp, MutationAuditCtx } from "../../audit/types.js"
import {
  canMoveComandaTo,
  mapComandaRow,
  resolveSendQuantity,
  timestampsForStatusChange,
  type ComandaDbRow,
  type MutateFail,
} from "./map.js"
import { getComandaTicket } from "./queries.js"
import {
  COMANDA_SELECT,
  type ComandaSendPeel,
  type ComandaSourceKind,
  type ComandaStatus,
  type ComandaTicket,
  type ComandaVoidPeel,
} from "./schema.js"

const VOIDABLE_STATUSES = ["sent", "preparing", "ready", "delivered"] as const

type SendRow = {
  id: string
  cart_line_id: string
  station_id: string
  quantity: number
  recipe_id: string | null
  recipe_name: string
  comment: string
  origin_label: string
  customer_name: string
  table_session_id: string | null
  counter_order_id: string | null
  source_kind: string
  source_id: string
  status?: string
}

export async function moveComandaStatus(
  supabase: SupabaseClient,
  popId: string,
  ticketId: string,
  nextStatus: ComandaStatus,
  audit: MutationAuditCtx,
): Promise<{ success: true; ticket: ComandaTicket } | MutateFail> {
  const { data: existing, error: existingErr } = await supabase
    .from("comandas")
    .select(COMANDA_SELECT)
    .eq("id", ticketId)
    .eq("pop_id", popId)
    .maybeSingle()
  if (existingErr) {
    return { success: false, error: existingErr.message, status: 500 }
  }
  if (!existing) {
    return { success: false, error: "Esa comanda no existe.", status: 404 }
  }

  const current = mapComandaRow(existing as ComandaDbRow)
  if (current.status === nextStatus) {
    return { success: true, ticket: current }
  }

  const isSend = current.status === "pending" && nextStatus === "sent"
  if (!isSend && !canMoveComandaTo(current.status, nextStatus)) {
    return {
      success: false,
      error: "Ese cambio de estado no está permitido.",
      status: 400,
    }
  }

  const now = new Date().toISOString()
  const patch = timestampsForStatusChange(
    {
      sentAt: current.sentAt,
      preparingAt: current.preparingAt,
      readyAt: current.readyAt,
      deliveredAt: current.deliveredAt,
    },
    nextStatus,
    now,
  )

  const ops: AuditOp[] = []
  const sendId = current.sendId
  if (sendId) {
    ops.push({ op: "update", table: "comanda_sends", id: sendId, row: patch })
    const { data: siblings, error: siblingsErr } = await supabase
      .from("comandas")
      .select("id")
      .eq("pop_id", popId)
      .eq("send_id", sendId)
    if (siblingsErr) {
      return { success: false, error: siblingsErr.message, status: 500 }
    }
    for (const sibling of siblings ?? []) {
      ops.push({
        op: "update",
        table: "comandas",
        id: String(sibling.id),
        row: patch,
      })
    }
  } else {
    ops.push({ op: "update", table: "comandas", id: ticketId, row: patch })
  }

  const applied = await applyWithAudit(supabase, {
    kind: "comandas.status",
    ctx: audit,
    popId,
    resourceId: ticketId,
    previous: current,
    next: { ...current, status: nextStatus, ...patch },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  const loaded = await getComandaTicket(supabase, popId, ticketId)
  if (!loaded.success) {
    return { success: false, error: loaded.error, status: 500 }
  }
  if (!loaded.ticket) {
    return {
      success: false,
      error: "No se pudo actualizar la comanda.",
      status: 500,
    }
  }
  return { success: true, ticket: loaded.ticket }
}

export async function sendComandaBatch(
  supabase: SupabaseClient,
  popId: string,
  input: {
    sourceKind: ComandaSourceKind
    sourceId: string
    quantities: Record<string, number>
    stationComments: Record<string, string>
  },
  audit: MutationAuditCtx,
): Promise<
  | { success: true; sentCartLineIds: string[]; peels: ComandaSendPeel[] }
  | MutateFail
> {
  const cartLineIds = [
    ...new Set(
      Object.entries(input.quantities)
        .filter(([, qty]) => resolveSendQuantity(qty, Number.MAX_SAFE_INTEGER) > 0)
        .map(([id]) => id.trim())
        .filter(Boolean),
    ),
  ]
  if (cartLineIds.length === 0) {
    return {
      success: false,
      error: "Elegí al menos un ítem para comandar.",
      status: 400,
    }
  }

  const { data: rows, error: loadErr } = await supabase
    .from("comandas")
    .select(
      `
      id,
      cart_line_id,
      station_id,
      quantity,
      recipe_id,
      recipe_name,
      comment,
      origin_label,
      customer_name,
      table_session_id,
      counter_order_id,
      source_kind,
      source_id
    `,
    )
    .eq("pop_id", popId)
    .eq("source_kind", input.sourceKind)
    .eq("source_id", input.sourceId)
    .eq("status", "pending")
    .in("cart_line_id", cartLineIds)
  if (loadErr) return { success: false, error: loadErr.message, status: 500 }

  const selected = ((rows ?? []) as SendRow[]).filter((row) => {
    const pendingQty = Math.max(1, Number(row.quantity) || 1)
    return (
      resolveSendQuantity(input.quantities[String(row.cart_line_id)], pendingQty) >
      0
    )
  })
  if (selected.length === 0) {
    return {
      success: false,
      error: "No hay ítems pendientes para comandar.",
      status: 400,
    }
  }

  const byStation = new Map<string, SendRow[]>()
  for (const row of selected) {
    const stationId = String(row.station_id)
    const list = byStation.get(stationId) ?? []
    list.push(row)
    byStation.set(stationId, list)
  }

  const now = new Date().toISOString()
  const sentCartLineIds: string[] = []
  const peels: ComandaSendPeel[] = []
  const ops: AuditOp[] = []

  for (const [stationId, items] of byStation) {
    const comment = (input.stationComments[stationId] ?? "").trim()
    const sendId = randomUUID()
    ops.push({
      op: "insert",
      table: "comanda_sends",
      row: {
        id: sendId,
        pop_id: popId,
        station_id: stationId,
        kind: "order",
        status: "sent",
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        table_session_id:
          input.sourceKind === "table" ? input.sourceId : null,
        counter_order_id:
          input.sourceKind === "counter" ? input.sourceId : null,
        comment,
        sent_at: now,
        status_changed_at: now,
      },
    })

    for (const item of items) {
      const fromCartLineId = String(item.cart_line_id)
      const pendingQty = Math.max(1, Number(item.quantity) || 1)
      const sendQty = resolveSendQuantity(
        input.quantities[fromCartLineId],
        pendingQty,
      )
      if (sendQty <= 0) continue

      if (sendQty < pendingQty) {
        const sentCartLineId = randomUUID()
        const remainderQty = pendingQty - sendQty
        ops.push({
          op: "insert",
          table: "comandas",
          row: {
            id: randomUUID(),
            pop_id: popId,
            station_id: item.station_id,
            status: "sent",
            send_id: sendId,
            source_kind: item.source_kind,
            source_id: item.source_id,
            table_session_id: item.table_session_id,
            counter_order_id: item.counter_order_id,
            cart_line_id: sentCartLineId,
            recipe_id: item.recipe_id,
            recipe_name: item.recipe_name,
            quantity: sendQty,
            comment: item.comment,
            origin_label: item.origin_label,
            customer_name: item.customer_name,
            sent_at: now,
            status_changed_at: now,
          },
        })
        ops.push({
          op: "update",
          table: "comandas",
          id: item.id,
          row: { quantity: remainderQty },
        })
        sentCartLineIds.push(sentCartLineId)
        peels.push({
          fromCartLineId,
          sentCartLineId,
          sentQuantity: sendQty,
          remainderQuantity: remainderQty,
        })
        continue
      }

      ops.push({
        op: "update",
        table: "comandas",
        id: item.id,
        row: {
          status: "sent",
          send_id: sendId,
          sent_at: now,
          status_changed_at: now,
        },
      })
      sentCartLineIds.push(fromCartLineId)
    }
  }

  const applied = await applyWithAudit(supabase, {
    kind: "comandas.send",
    ctx: audit,
    popId,
    resourceId: input.sourceId,
    previous: null,
    next: {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sentCartLineIds,
      peels,
    },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  return { success: true, sentCartLineIds, peels }
}

export async function voidComandaBatch(
  supabase: SupabaseClient,
  popId: string,
  input: {
    sourceKind: ComandaSourceKind
    sourceId: string
    parentCartLineId: string
    parentVoidQuantity: number
    parentRemainderQuantity: number
    quantities: Record<string, number>
    comment: string
  },
  audit: MutationAuditCtx,
): Promise<
  | {
      success: true
      voidedCartLineIds: string[]
      peels: ComandaVoidPeel[]
    }
  | MutateFail
> {
  const parentCartLineId = input.parentCartLineId.trim()
  if (!parentCartLineId) {
    return { success: false, error: "Línea inválida.", status: 400 }
  }

  const cartLineIds = [
    ...new Set(
      Object.entries(input.quantities)
        .filter(([, qty]) => resolveSendQuantity(qty, Number.MAX_SAFE_INTEGER) > 0)
        .map(([id]) => id.trim())
        .filter(Boolean),
    ),
  ]
  if (cartLineIds.length === 0) {
    return {
      success: false,
      error: "Elegí al menos un ítem para anular.",
      status: 400,
    }
  }

  const { data: rows, error: loadErr } = await supabase
    .from("comandas")
    .select(
      `
      id,
      cart_line_id,
      station_id,
      quantity,
      recipe_id,
      recipe_name,
      comment,
      origin_label,
      customer_name,
      table_session_id,
      counter_order_id,
      source_kind,
      source_id,
      status
    `,
    )
    .eq("pop_id", popId)
    .eq("source_kind", input.sourceKind)
    .eq("source_id", input.sourceId)
    .in("status", [...VOIDABLE_STATUSES])
    .in("cart_line_id", cartLineIds)
  if (loadErr) return { success: false, error: loadErr.message, status: 500 }

  const selected = ((rows ?? []) as SendRow[]).filter((row) => {
    const currentQty = Math.max(1, Number(row.quantity) || 1)
    return (
      resolveSendQuantity(input.quantities[String(row.cart_line_id)], currentQty) >
      0
    )
  })
  if (selected.length === 0) {
    return {
      success: false,
      error: "No hay ítems comandados para anular.",
      status: 400,
    }
  }

  const byStation = new Map<string, SendRow[]>()
  for (const row of selected) {
    const stationId = String(row.station_id)
    const list = byStation.get(stationId) ?? []
    list.push(row)
    byStation.set(stationId, list)
  }

  const now = new Date().toISOString()
  const comment = input.comment.trim()
  const ops: AuditOp[] = []

  for (const [stationId, items] of byStation) {
    const sendId = randomUUID()
    ops.push({
      op: "insert",
      table: "comanda_sends",
      row: {
        id: sendId,
        pop_id: popId,
        station_id: stationId,
        kind: "void",
        status: "sent",
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        table_session_id:
          input.sourceKind === "table" ? input.sourceId : null,
        counter_order_id:
          input.sourceKind === "counter" ? input.sourceId : null,
        comment,
        sent_at: now,
        status_changed_at: now,
      },
    })

    for (const item of items) {
      const fromCartLineId = String(item.cart_line_id)
      const currentQty = Math.max(1, Number(item.quantity) || 1)
      const voidQty = resolveSendQuantity(
        input.quantities[fromCartLineId],
        currentQty,
      )
      if (voidQty <= 0) continue

      ops.push({
        op: "insert",
        table: "comandas",
        row: {
          id: randomUUID(),
          pop_id: popId,
          station_id: item.station_id,
          status: "sent",
          send_id: sendId,
          source_kind: item.source_kind,
          source_id: item.source_id,
          table_session_id: item.table_session_id,
          counter_order_id: item.counter_order_id,
          cart_line_id: randomUUID(),
          recipe_id: item.recipe_id,
          recipe_name: item.recipe_name,
          quantity: voidQty,
          comment: item.comment,
          origin_label: item.origin_label,
          customer_name: item.customer_name,
          sent_at: now,
          status_changed_at: now,
        },
      })

      if (voidQty < currentQty) {
        ops.push({
          op: "update",
          table: "comandas",
          id: item.id,
          row: { quantity: currentQty - voidQty },
        })
        continue
      }

      ops.push({
        op: "update",
        table: "comandas",
        id: item.id,
        row: {
          status: "voided",
          voided_at: now,
          status_changed_at: now,
        },
      })
    }
  }

  const parentVoidQty = Math.max(1, Math.round(input.parentVoidQuantity) || 1)
  const parentRemainder = Math.max(
    0,
    Math.round(input.parentRemainderQuantity) || 0,
  )
  const result =
    parentRemainder <= 0
      ? {
          voidedCartLineIds: [parentCartLineId],
          peels: [] as ComandaVoidPeel[],
        }
      : {
          voidedCartLineIds: [] as string[],
          peels: [
            {
              fromCartLineId: parentCartLineId,
              voidedCartLineId: randomUUID(),
              voidedQuantity: parentVoidQty,
              remainderQuantity: parentRemainder,
            },
          ],
        }

  const applied = await applyWithAudit(supabase, {
    kind: "comandas.void",
    ctx: audit,
    popId,
    resourceId: input.sourceId,
    previous: null,
    next: {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      ...result,
    },
    ops,
  })
  if (!applied.success) {
    return { success: false, error: applied.error, status: applied.status }
  }

  return { success: true, ...result }
}
