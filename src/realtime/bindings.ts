import type { PublishableDomainEvent } from "./protocol.js"

export type PopRealtimeStub = {
  publish(event: PublishableDomainEvent): Promise<{ seq: number }>
  fetch(request: Request): Promise<Response>
}

export type RealtimeBindings = {
  POP_REALTIME?: {
    getByName(name: string): PopRealtimeStub
  }
}

export function getPopRealtimeStub(
  env: RealtimeBindings | undefined,
  popId: string,
): PopRealtimeStub | null {
  const ns = env?.POP_REALTIME
  if (!ns) return null
  return ns.getByName(popId)
}
