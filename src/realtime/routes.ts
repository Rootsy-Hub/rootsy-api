import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../sidecar/pop.js"
import { getPopRealtimeStub, type RealtimeBindings } from "./bindings.js"
import { publishDomainEvent } from "./bus.js"
import {
  isValidEventType,
  parseChannels,
} from "./channels.js"
import {
  REALTIME_MAX_PAYLOAD_BYTES,
  type PublishableDomainEvent,
} from "./protocol.js"
import {
  requireRealtimeSession,
  type RealtimeSessionEnv,
} from "./session.js"

const publishBodySchema = z.object({
  type: z.string().min(3).max(80),
  payload: z.record(z.string(), z.unknown()).optional(),
  resource: z
    .object({
      type: z.string().min(1).max(64),
      id: z.string().min(1).max(64),
    })
    .optional(),
  require: z
    .object({
      permissions: z.array(z.string().min(1).max(80)).max(16).optional(),
    })
    .optional(),
  channels: z.array(z.string().min(1).max(160)).max(16).optional(),
})

export const realtimeWsRoutes = new Hono<RealtimeSessionEnv>()

realtimeWsRoutes.get("/", requireRealtimeSession, async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ success: false, error: "Expected WebSocket" }, 426)
  }

  const stub = getPopRealtimeStub(c.env, c.get("realtimeSession").popId)
  if (!stub) {
    return c.json(
      { success: false, error: "Realtime requiere wrangler dev" },
      501,
    )
  }

  const session = c.get("realtimeSession")
  const headers = new Headers(c.req.raw.headers)
  headers.set("x-rootsy-realtime-user-id", session.userId)
  headers.set("x-rootsy-realtime-display-name", session.displayName)
  headers.set("x-rootsy-realtime-keys", session.keys.join(","))
  headers.set("x-rootsy-realtime-owner", session.isOwner ? "1" : "0")
  headers.set("x-rootsy-realtime-pop-id", session.popId)

  return stub.fetch(new Request(c.req.raw, { headers }))
})

type PublishEnv = SidecarEnv & { Bindings: RealtimeBindings }

export const realtimePublishRoutes = new Hono<PublishEnv>()

realtimePublishRoutes.post("/events", async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: "JSON inválido" }, 400)
  }

  const parsed = publishBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: "Payload inválido" }, 400)
  }
  if (!isValidEventType(parsed.data.type)) {
    return c.json({ success: false, error: "type inválido" }, 400)
  }
  if (parsed.data.channels) {
    const channels = parseChannels(parsed.data.channels)
    if (!channels) {
      return c.json({ success: false, error: "channels inválidos" }, 400)
    }
  }

  const encodedPayload = JSON.stringify(parsed.data.payload ?? {})
  if (new TextEncoder().encode(encodedPayload).length > REALTIME_MAX_PAYLOAD_BYTES) {
    return c.json({ success: false, error: "payload demasiado grande" }, 413)
  }

  const sidecar = c.get("sidecar")
  const event: PublishableDomainEvent = {
    id: crypto.randomUUID(),
    type: parsed.data.type,
    popId: sidecar.popId,
    actorId: c.get("userId"),
    occurredAt: new Date().toISOString(),
    payload: parsed.data.payload ?? {},
    resource: parsed.data.resource,
    require: parsed.data.require,
    channels: parsed.data.channels,
  }

  const result = await publishDomainEvent(c.env, event)
  if (!result) {
    return c.json(
      { success: false, error: "Realtime requiere wrangler dev" },
      501,
    )
  }

  return c.json({ success: true, seq: result.seq })
})
