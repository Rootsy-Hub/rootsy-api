export type AuditExecutionSource = "user" | "rootsy_ai" | "system"

export type AuditAction = "create" | "update" | "delete"

export type MutationAuditCtx = {
  executionSource: AuditExecutionSource
  requesterUserId: string
  approverUserId: string | null
  resource: string
  action: AuditAction
  httpMethod: string
  path: string
}

export type AuditOp =
  | { op: "insert"; table: string; row: Record<string, unknown> }
  | { op: "update"; table: string; id: string; row: Record<string, unknown> }
  | { op: "delete"; table: string; id: string }

const SECRET_KEYS = new Set([
  "clock_pin",
  "code_hash",
  "code_fingerprint",
  "approval_code",
  "pin",
  "password",
  "secret",
])

export function redactAuditJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditJson)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key)) continue
      out[key] = redactAuditJson(nested)
    }
    return out
  }
  return value
}

export function jsonDiff(
  previous: unknown,
  next: unknown,
): { previous_state: unknown; new_state: unknown } {
  const before = redactAuditJson(previous)
  const after = redactAuditJson(next)
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const prevObj = before as Record<string, unknown>
    const nextObj = after as Record<string, unknown>
    const prevOut: Record<string, unknown> = {}
    const nextOut: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(prevObj), ...Object.keys(nextObj)])
    for (const key of keys) {
      if (JSON.stringify(prevObj[key]) === JSON.stringify(nextObj[key])) continue
      if (key in prevObj) prevOut[key] = prevObj[key]
      if (key in nextObj) nextOut[key] = nextObj[key]
    }
    return { previous_state: prevOut, new_state: nextOut }
  }
  return { previous_state: before, new_state: after }
}

export function snapshotState(
  action: AuditAction,
  previous: unknown,
  next: unknown,
): { previous_state: unknown; new_state: unknown } {
  if (action === "update") return jsonDiff(previous, next)
  return {
    previous_state: redactAuditJson(previous),
    new_state: redactAuditJson(next),
  }
}

export function requestApprovalKeys(
  executeAllowlist: readonly string[],
): string[] {
  return executeAllowlist.map((key) => `${key}:request_approval`)
}

export function resourceActionFromAllowlist(
  executeAllowlist: readonly string[],
): { resource: string; action: AuditAction } {
  const first = executeAllowlist[0] ?? "unknown:update"
  const i = first.indexOf(":")
  const resource = i > 0 ? first.slice(0, i) : first
  const actionRaw = i > 0 ? first.slice(i + 1) : "update"
  const action: AuditAction =
    actionRaw === "create" || actionRaw === "delete" || actionRaw === "update"
      ? actionRaw
      : "update"
  return { resource, action }
}
