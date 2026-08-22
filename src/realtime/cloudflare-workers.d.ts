declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env)
    readonly ctx: DurableObjectState
    readonly env: Env
  }
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage
  blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T>
  acceptWebSocket(ws: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): WebSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
}

interface DurableObjectStorage {
  readonly sql: SqlStorage
}

interface SqlStorage {
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T>
}

type SqlStorageValue = ArrayBuffer | string | number | null

interface SqlStorageCursor<T> {
  one(): T
  toArray(): T[]
}

interface WebSocket {
  serializeAttachment(attachment: unknown): void
  deserializeAttachment(): unknown
}

interface ResponseInit {
  webSocket?: WebSocket
}

declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string)
}
