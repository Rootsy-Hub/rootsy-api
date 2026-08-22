import { getPopRealtimeStub, type RealtimeBindings } from "./bindings.js"
import type { PublishableDomainEvent } from "./protocol.js"

export async function publishDomainEvent(
  env: RealtimeBindings | undefined,
  event: PublishableDomainEvent,
): Promise<{ seq: number } | null> {
  const stub = getPopRealtimeStub(env, event.popId)
  if (!stub) return null
  return stub.publish(event)
}
