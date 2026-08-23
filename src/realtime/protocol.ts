/** Contrato de cable Rootsy realtime. Mantener alineado con rootsy-web/lib/realtime/protocol.ts */

export const REALTIME_EVENT_BUFFER_SIZE = 500
export const REALTIME_MAX_CHANNELS_PER_CONNECTION = 32
export const REALTIME_MAX_PAYLOAD_BYTES = 8 * 1024

export type RealtimeResourceRef = {
  type: string
  id: string
}

export type DomainEvent = {
  id: string
  seq: number
  type: string
  popId: string
  actorId: string
  occurredAt: string
  resource?: RealtimeResourceRef
  payload: Record<string, unknown>
  require?: { permissions?: string[] }
  /** Si está, solo esos userIds reciben el evento. El owner no bypasea. */
  visibleTo?: string[]
  channels?: string[]
}

export type PublishableDomainEvent = Omit<DomainEvent, "seq">

export type PresenceMember = {
  userId: string
  displayName: string
  connectionCount: number
}

export type ClientMessage =
  | { type: "subscribe"; channels: string[]; lastSeq?: number }
  | { type: "unsubscribe"; channels: string[] }
  | { type: "ping" }

export type ServerMessage =
  | { type: "hello"; connectionId: string; seq: number }
  | { type: "subscribed"; channels: string[] }
  | { type: "unsubscribed"; channels: string[] }
  | { type: "event"; event: DomainEvent }
  | { type: "replay"; events: DomainEvent[] }
  | { type: "resync"; channels: string[]; reason: "gap" | "empty" }
  | { type: "pong"; at: number }
  | { type: "presence"; members: PresenceMember[] }
  | { type: "error"; code: string; message: string }

export type ConnectionAttachment = {
  connectionId: string
  userId: string
  displayName: string
  keys: string[]
  isOwner: boolean
  channels: string[]
}
