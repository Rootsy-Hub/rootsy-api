import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import { cajasUserChannel } from "../../realtime/channels.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { OPERATE_OPEN_SESSION_READ } from "./allowlist.js"
import type { OperateOpenCashSession } from "./openSession.js"

export type CajasEventType = "cajas.session_opened" | "cajas.session_closed"

export function cajasSessionOpenedPayload(
  session: OperateOpenCashSession,
): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    cashRegisterId: session.cashRegisterId,
    openedAt: session.openedAt,
    salePoint: session.salePoint,
  }
}

export async function publishCajasEvent(
  c: Context<SidecarEnv>,
  input: {
    type: CajasEventType
    userId: string
    payload?: Record<string, unknown>
  },
): Promise<void> {
  const sidecar = c.get("sidecar")
  await publishDomainEvent(c.env, {
    id: crypto.randomUUID(),
    type: input.type,
    popId: sidecar.popId,
    actorId: c.get("userId"),
    occurredAt: new Date().toISOString(),
    resource: { type: "cajas", id: input.userId },
    payload: input.payload ?? {},
    require: { permissions: [...OPERATE_OPEN_SESSION_READ] },
    visibleTo: [input.userId],
    channels: [cajasUserChannel(input.userId)],
  })
}

export async function publishCajasEventBestEffort(
  c: Context<SidecarEnv>,
  input: Parameters<typeof publishCajasEvent>[1],
): Promise<void> {
  try {
    await publishCajasEvent(c, input)
  } catch {
    /* la mutación no falla si el aviso no sale */
  }
}
