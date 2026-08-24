import type { Context } from "hono"
import { publishDomainEvent } from "../../realtime/bus.js"
import type { SidecarEnv } from "../../sidecar/pop.js"
import type { ChatMessageRow } from "./schema.js"

type ChatPublishEnv = SidecarEnv

export async function publishChatEvent(
  c: Context<ChatPublishEnv>,
  input: {
    type: "chat.message" | "chat.created" | "chat.updated" | "chat.deleted"
    channelId: string
    visibleTo: string[]
    payload?: Record<string, unknown>
  },
): Promise<void> {
  if (!input.visibleTo.length) return
  const sidecar = c.get("sidecar")
  await publishDomainEvent(c.env, {
    id: crypto.randomUUID(),
    type: input.type,
    popId: sidecar.popId,
    actorId: c.get("userId"),
    occurredAt: new Date().toISOString(),
    resource: { type: "chat", id: input.channelId },
    payload: input.payload ?? {},
    visibleTo: input.visibleTo,
    require: { permissions: ["chat:read"] },
  })
}

export function chatMessagePayload(
  channelId: string,
  message: ChatMessageRow,
): Record<string, unknown> {
  return {
    channelId,
    message: {
      id: message.id,
      authorUserId: message.authorUserId,
      authorName: message.authorName,
      authorImageUrl: message.authorImageUrl,
      body: message.body,
      createdAt: message.createdAt,
    },
  }
}
