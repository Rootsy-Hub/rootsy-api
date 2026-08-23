import type { ConnectionAttachment, DomainEvent } from "./protocol.js"

const DOMAIN_RE = /^[a-z][a-z0-9-]{0,62}$/
const RESOURCE_TYPE_RE = /^[a-z][a-z0-9-]{0,62}$/
const RESOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sameUserId(a: string, b: string): boolean {
  return a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase()
}

export function isValidEventType(type: string): boolean {
  return EVENT_TYPE_RE.test(type)
}

export function domainFromEventType(type: string): string | null {
  const dot = type.indexOf(".")
  if (dot <= 0) return null
  const domain = type.slice(0, dot)
  return DOMAIN_RE.test(domain) ? domain : null
}

export function parseChannel(raw: string): string | null {
  const channel = raw.trim()
  if (channel === "presence") return channel

  if (channel.startsWith("domain:")) {
    const domain = channel.slice("domain:".length)
    return DOMAIN_RE.test(domain) ? `domain:${domain}` : null
  }

  if (channel.startsWith("resource:")) {
    const rest = channel.slice("resource:".length)
    const sep = rest.indexOf(":")
    if (sep <= 0) return null
    const type = rest.slice(0, sep)
    const id = rest.slice(sep + 1)
    if (!RESOURCE_TYPE_RE.test(type) || !RESOURCE_ID_RE.test(id)) return null
    return `resource:${type}:${id}`
  }

  if (channel.startsWith("user:")) {
    const userId = channel.slice("user:".length)
    return UUID_RE.test(userId) ? `user:${userId}` : null
  }

  return null
}

export function parseChannels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== "string") return null
    const channel = parseChannel(item)
    if (!channel) return null
    if (seen.has(channel)) continue
    seen.add(channel)
    out.push(channel)
  }
  return out
}

export function canSubscribeToChannel(
  channel: string,
  session: Pick<ConnectionAttachment, "userId" | "keys" | "isOwner">,
): boolean {
  if (channel === "presence") return true

  if (channel.startsWith("domain:")) {
    if (session.isOwner) return true
    const domain = channel.slice("domain:".length)
    return session.keys.some((key) => key === `${domain}:read` || key.startsWith(`${domain}:`))
  }

  if (channel.startsWith("resource:")) return true

  if (channel.startsWith("user:")) {
    return sameUserId(channel.slice("user:".length), session.userId)
  }

  return false
}

export function channelsForEvent(event: DomainEvent): string[] {
  if (event.channels?.length) {
    const parsed = parseChannels(event.channels)
    return parsed ?? []
  }

  const channels: string[] = []
  const domain = domainFromEventType(event.type)
  if (domain) channels.push(`domain:${domain}`)
  if (event.resource) {
    channels.push(`resource:${event.resource.type}:${event.resource.id}`)
  }
  return channels
}

export function canReceiveEvent(
  session: ConnectionAttachment,
  event: DomainEvent,
  eventChannels: string[],
): boolean {
  if (event.visibleTo) {
    const allowed = event.visibleTo.some((id) => sameUserId(id, session.userId))
    if (!allowed) return false
  }

  if (event.require?.permissions?.length) {
    if (
      !session.isOwner &&
      !event.require.permissions.some((key) => session.keys.includes(key))
    ) {
      return false
    }
  }

  return eventChannels.some((channel) => session.channels.includes(channel))
}
