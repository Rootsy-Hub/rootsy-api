import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { hasAnyPermission, requireAnyPermission } from "../../sidecar/permissions.js"
import { CHAT_CREATE, CHAT_DELETE, CHAT_READ, CHAT_UPDATE } from "./allowlist.js"
import {
  createChatChannel,
  deleteChatChannel,
  getChatChannel,
  getChatWorkspace,
  listChatChannelMemberIds,
  markChatChannelRead,
  sendChatMessage,
  updateChatChannel,
} from "./queries.js"
import { chatMessagePayload, publishChatEvent } from "./realtime.js"
import {
  createChannelBodySchema,
  sendMessageBodySchema,
  updateChannelBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const chatRoutes = new Hono<SidecarEnv>()

function bodyError(issues: { message: string }[]) {
  return {
    success: false as const,
    error: issues[0]?.message ?? "Body inválido",
  }
}

chatRoutes.get("/", async (c) => {
  const sidecar = c.get("sidecar")
  if (!hasAnyPermission(sidecar.keys, CHAT_READ, sidecar.isOwner)) {
    return c.json(
      {
        success: false,
        error: "No tenés permiso para ver Chat en este punto de venta.",
        redirect: `/${sidecar.popSiteId}/${sidecar.popId}`,
      },
      403,
    )
  }
  const result = await getChatWorkspace(
    c.get("supabase"),
    sidecar.popId,
    c.get("userId"),
    sidecar.keys,
    sidecar.isOwner,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

chatRoutes.post("/", requireAnyPermission([...CHAT_READ, ...CHAT_CREATE]), async (c) => {
  const body = createChannelBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const result = await createChatChannel(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  const visibleTo = await listChatChannelMemberIds(
    c.get("supabase"),
    c.get("sidecar").popId,
    result.data.id,
  )
  void publishChatEvent(c, {
    type: "chat.created",
    channelId: result.data.id,
    visibleTo,
    payload: { channelId: result.data.id },
  }).catch(() => undefined)
  return c.json(result, 201)
})

chatRoutes.get(
  "/:channelId/messages",
  requireAnyPermission(CHAT_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("channelId"))
    if (!id.success) {
      return c.json({ success: false, error: "channelId inválido" }, 400)
    }
    const result = await getChatChannel(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

chatRoutes.post(
  "/:channelId/messages",
  requireAnyPermission(CHAT_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("channelId"))
    if (!id.success) {
      return c.json({ success: false, error: "channelId inválido" }, 400)
    }
    const body = sendMessageBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) return c.json(bodyError(body.error.issues), 400)
    const result = await sendChatMessage(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      id.data,
      body.data.body,
    )
    if (!result.success) return c.json(result, result.status)
    const visibleTo = await listChatChannelMemberIds(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    void publishChatEvent(c, {
      type: "chat.message",
      channelId: id.data,
      visibleTo,
      payload: chatMessagePayload(id.data, result.data),
    }).catch(() => undefined)
    return c.json(result, 201)
  },
)

chatRoutes.post(
  "/:channelId/read",
  requireAnyPermission(CHAT_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("channelId"))
    if (!id.success) {
      return c.json({ success: false, error: "channelId inválido" }, 400)
    }
    const result = await markChatChannelRead(
      c.get("supabase"),
      c.get("sidecar").popId,
      c.get("userId"),
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

chatRoutes.get("/:channelId", requireAnyPermission(CHAT_READ), async (c) => {
  const id = idSchema.safeParse(c.req.param("channelId"))
  if (!id.success) {
    return c.json({ success: false, error: "channelId inválido" }, 400)
  }
  const result = await getChatChannel(
    c.get("supabase"),
    c.get("sidecar").popId,
    c.get("userId"),
    id.data,
  )
  if (!result.success) return c.json(result, result.status)
  return c.json(result)
})

chatRoutes.patch(
  "/:channelId",
  requireAnyPermission([...CHAT_READ, ...CHAT_UPDATE]),
  async (c) => {
  const id = idSchema.safeParse(c.req.param("channelId"))
  if (!id.success) {
    return c.json({ success: false, error: "channelId inválido" }, 400)
  }
  const body = updateChannelBodySchema.safeParse(
    await c.req.json().catch(() => null),
  )
  if (!body.success) return c.json(bodyError(body.error.issues), 400)
  const supabase = c.get("supabase")
  const popId = c.get("sidecar").popId
  const before = await listChatChannelMemberIds(supabase, popId, id.data)
  const result = await updateChatChannel(
    supabase,
    popId,
    c.get("userId"),
    id.data,
    body.data,
  )
  if (!result.success) return c.json(result, result.status)
  const after = await listChatChannelMemberIds(supabase, popId, id.data)
  void publishChatEvent(c, {
    type: "chat.updated",
    channelId: id.data,
    visibleTo: [...new Set([...before, ...after])],
    payload: { channelId: id.data },
  }).catch(() => undefined)
  return c.json(result)
})

chatRoutes.delete("/:channelId", requireAnyPermission(CHAT_DELETE), async (c) => {
  const id = idSchema.safeParse(c.req.param("channelId"))
  if (!id.success) {
    return c.json({ success: false, error: "channelId inválido" }, 400)
  }
  const supabase = c.get("supabase")
  const popId = c.get("sidecar").popId
  const visibleTo = await listChatChannelMemberIds(supabase, popId, id.data)
  const result = await deleteChatChannel(supabase, popId, id.data)
  if (!result.success) return c.json(result, result.status)
  void publishChatEvent(c, {
    type: "chat.deleted",
    channelId: id.data,
    visibleTo,
    payload: { channelId: id.data },
  }).catch(() => undefined)
  return c.json(result)
})
