import { createHmac, timingSafeEqual } from "node:crypto"

export function signRootsyAiExecution(input: {
  secret: string
  userId: string
  popId: string
  method: string
  path: string
  timestamp?: number
  nonce?: string
}): string {
  const timestamp = input.timestamp ?? Date.now()
  const nonce =
    input.nonce ?? createHmac("sha256", `${timestamp}`).digest("hex").slice(0, 16)
  const payload = `${timestamp}.${nonce}.${input.userId}.${input.popId}.${input.method.toUpperCase()}.${input.path}`
  const sig = createHmac("sha256", input.secret).update(payload).digest("hex")
  return `v1=${timestamp}.${nonce}.${sig}`
}

export function verifyRootsyAiExecutionHeader(input: {
  header: string | undefined
  secret: string
  userId: string
  popId: string
  method: string
  path: string
  now?: number
  maxAgeMs?: number
}): boolean {
  const raw = input.header?.trim()
  if (!raw) return false
  const match = /^v1=(\d+)\.([A-Za-z0-9]+)\.([a-f0-9]+)$/.exec(raw)
  if (!match) return false
  const timestamp = Number(match[1])
  const nonce = match[2]
  const sig = match[3]
  const now = input.now ?? Date.now()
  const maxAge = input.maxAgeMs ?? 2 * 60 * 1000
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > maxAge) return false
  const payload = `${timestamp}.${nonce}.${input.userId}.${input.popId}.${input.method.toUpperCase()}.${input.path}`
  const expected = createHmac("sha256", input.secret).update(payload).digest("hex")
  const left = Buffer.from(sig, "hex")
  const right = Buffer.from(expected, "hex")
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}
