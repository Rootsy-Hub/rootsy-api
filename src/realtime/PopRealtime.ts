import { DurableObject } from "cloudflare:workers"
import {
  canReceiveEvent,
  canSubscribeToChannel,
  channelsForEvent,
  parseChannels,
} from "./channels.js"
import {
  REALTIME_EVENT_BUFFER_SIZE,
  REALTIME_MAX_CHANNELS_PER_CONNECTION,
  type ClientMessage,
  type ConnectionAttachment,
  type DomainEvent,
  type PresenceMember,
  type PublishableDomainEvent,
  type ServerMessage,
} from "./protocol.js"

type EventRow = {
  seq: number
  json: string
}

export class PopRealtime extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    )
    this.ctx.blockConcurrencyWhile(async () => {
      this.migrate()
    })
  }

  private migrate() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    const current = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations",
      )
      .one().version

    if (current < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL,
          json TEXT NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `)
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ success: false, error: "Expected WebSocket" }, { status: 426 })
    }

    const session = sessionFromHeaders(request.headers)
    if (!session) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)

    const attachment: ConnectionAttachment = {
      connectionId: crypto.randomUUID(),
      userId: session.userId,
      displayName: session.displayName,
      keys: session.keys,
      isOwner: session.isOwner,
      channels: [],
    }
    server.serializeAttachment(attachment)

    this.send(server, {
      type: "hello",
      connectionId: attachment.connectionId,
      seq: this.currentSeq(),
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async publish(event: PublishableDomainEvent): Promise<{ seq: number }> {
    const seq = this.currentSeq() + 1
    const stored: DomainEvent = { ...event, seq }
    const json = JSON.stringify(stored)

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)",
      String(seq),
    )
    this.ctx.storage.sql.exec(
      "INSERT INTO events (seq, id, json) VALUES (?, ?, ?)",
      seq,
      stored.id,
      json,
    )
    this.ctx.storage.sql.exec(
      "DELETE FROM events WHERE seq <= ?",
      seq - REALTIME_EVENT_BUFFER_SIZE,
    )

    this.broadcastEvent(stored)
    return { seq }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") {
      this.send(ws, {
        type: "error",
        code: "invalid_message",
        message: "Mensaje inválido",
      })
      return
    }
    if (message === "ping") return

    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      this.send(ws, {
        type: "error",
        code: "invalid_json",
        message: "JSON inválido",
      })
      return
    }

    const incoming = parsed as ClientMessage
    const session = this.attachmentOf(ws)
    if (!session) return

    if (incoming.type === "ping") {
      this.send(ws, { type: "pong", at: Date.now() })
      return
    }

    if (incoming.type === "subscribe") {
      this.handleSubscribe(ws, session, incoming.channels, incoming.lastSeq)
      return
    }

    if (incoming.type === "unsubscribe") {
      this.handleUnsubscribe(ws, session, incoming.channels)
      return
    }

    this.send(ws, {
      type: "error",
      code: "unknown_type",
      message: "Tipo de mensaje desconocido",
    })
  }

  async webSocketClose(ws: WebSocket) {
    const session = this.attachmentOf(ws)
    if (session?.channels.includes("presence")) {
      this.broadcastPresence()
    }
  }

  private handleSubscribe(
    ws: WebSocket,
    session: ConnectionAttachment,
    rawChannels: string[],
    lastSeq?: number,
  ) {
    const parsed = parseChannels(rawChannels)
    if (!parsed) {
      this.send(ws, {
        type: "error",
        code: "invalid_channel",
        message: "Canal inválido",
      })
      return
    }

    const accepted: string[] = []
    for (const channel of parsed) {
      if (!canSubscribeToChannel(channel, session)) continue
      accepted.push(channel)
    }

    const next = new Set(session.channels)
    for (const channel of accepted) next.add(channel)

    if (next.size > REALTIME_MAX_CHANNELS_PER_CONNECTION) {
      this.send(ws, {
        type: "error",
        code: "too_many_channels",
        message: "Demasiados canales",
      })
      return
    }

    const joinedPresence = accepted.includes("presence") && !session.channels.includes("presence")
    session.channels = [...next]
    ws.serializeAttachment(session)
    this.send(ws, { type: "subscribed", channels: accepted })

    if (joinedPresence) this.broadcastPresence()
    this.replayOrResync(ws, session, accepted, lastSeq)
  }

  private handleUnsubscribe(
    ws: WebSocket,
    session: ConnectionAttachment,
    rawChannels: string[],
  ) {
    const parsed = parseChannels(rawChannels)
    if (!parsed) {
      this.send(ws, {
        type: "error",
        code: "invalid_channel",
        message: "Canal inválido",
      })
      return
    }

    const leftPresence = parsed.includes("presence") && session.channels.includes("presence")
    session.channels = session.channels.filter((channel) => !parsed.includes(channel))
    ws.serializeAttachment(session)
    this.send(ws, { type: "unsubscribed", channels: parsed })
    if (leftPresence) this.broadcastPresence()
  }

  private replayOrResync(
    ws: WebSocket,
    session: ConnectionAttachment,
    channels: string[],
    lastSeq?: number,
  ) {
    if (lastSeq == null || !Number.isFinite(lastSeq) || lastSeq < 0) {
      this.send(ws, { type: "resync", channels, reason: "empty" })
      return
    }

    const current = this.currentSeq()
    if (lastSeq >= current) return

    const minRow = this.ctx.storage.sql
      .exec<{ minSeq: number | null }>("SELECT MIN(seq) as minSeq FROM events")
      .one()
    const minSeq = minRow.minSeq
    if (minSeq == null || lastSeq < minSeq - 1) {
      this.send(ws, { type: "resync", channels, reason: "gap" })
      return
    }

    const rows = this.ctx.storage.sql
      .exec<EventRow>(
        "SELECT seq, json FROM events WHERE seq > ? ORDER BY seq ASC",
        lastSeq,
      )
      .toArray()

    const events: DomainEvent[] = []
    for (const row of rows) {
      const event = decodeEvent(row.json)
      if (!event) continue
      const eventChannels = channelsForEvent(event)
      if (!eventChannels.some((channel) => channels.includes(channel))) continue
      if (!canReceiveEvent(session, event, eventChannels)) continue
      events.push(event)
    }

    if (events.length) {
      this.send(ws, { type: "replay", events })
    }
  }

  private broadcastEvent(event: DomainEvent) {
    const eventChannels = channelsForEvent(event)
    if (!eventChannels.length) return

    for (const ws of this.ctx.getWebSockets()) {
      const session = this.attachmentOf(ws)
      if (!session) continue
      if (!canReceiveEvent(session, event, eventChannels)) continue
      this.send(ws, { type: "event", event })
    }
  }

  private broadcastPresence() {
    const members = this.presenceMembers()
    const message: ServerMessage = { type: "presence", members }
    for (const ws of this.ctx.getWebSockets()) {
      const session = this.attachmentOf(ws)
      if (!session?.channels.includes("presence")) continue
      this.send(ws, message)
    }
  }

  private presenceMembers(): PresenceMember[] {
    const counts = new Map<string, PresenceMember>()
    for (const ws of this.ctx.getWebSockets()) {
      const session = this.attachmentOf(ws)
      if (!session) continue
      const current = counts.get(session.userId)
      if (current) {
        current.connectionCount += 1
        continue
      }
      counts.set(session.userId, {
        userId: session.userId,
        displayName: session.displayName,
        connectionCount: 1,
      })
    }
    return [...counts.values()]
  }

  private currentSeq(): number {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seq'")
      .toArray()[0]
    const seq = row ? Number(row.value) : 0
    return Number.isFinite(seq) ? seq : 0
  }

  private attachmentOf(ws: WebSocket): ConnectionAttachment | null {
    const raw = ws.deserializeAttachment()
    if (!raw || typeof raw !== "object") return null
    return raw as ConnectionAttachment
  }

  private send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message))
  }
}

function sessionFromHeaders(headers: Headers): {
  userId: string
  displayName: string
  keys: string[]
  isOwner: boolean
} | null {
  const userId = headers.get("x-rootsy-realtime-user-id")?.trim()
  if (!userId) return null
  const displayName =
    headers.get("x-rootsy-realtime-display-name")?.trim() || "Usuario"
  const keysRaw = headers.get("x-rootsy-realtime-keys") ?? ""
  const keys = keysRaw
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
  const isOwner = headers.get("x-rootsy-realtime-owner") === "1"
  return { userId, displayName, keys, isOwner }
}

function decodeEvent(json: string): DomainEvent | null {
  try {
    const value = JSON.parse(json) as DomainEvent
    if (!value || typeof value.seq !== "number" || typeof value.type !== "string") {
      return null
    }
    return value
  } catch {
    return null
  }
}
