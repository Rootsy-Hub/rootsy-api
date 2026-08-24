import { z } from "zod"

export const PATCH_AT_LEAST_ONE_FIELD =
  "Mandá al menos un campo para actualizar."

export function mergePatch<T extends object>(
  current: T,
  patch: Partial<T>,
): T {
  return { ...current, ...patch }
}

function pickSentFields<T extends Record<string, unknown>>(
  parsed: T,
  raw: unknown,
): Partial<T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const sent = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(sent)) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      out[key] = parsed[key]
    }
  }
  return out as Partial<T>
}

export function parsePatchBody<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  raw: unknown,
):
  | { success: true; data: Partial<z.infer<T>> }
  | { success: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { success: false, error: "Body inválido" }
  }
  const sentKeys = Object.keys(raw)
  if (sentKeys.length === 0) {
    return { success: false, error: PATCH_AT_LEAST_ONE_FIELD }
  }

  const parsed = schema.partial().safeParse(raw)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Body inválido",
    }
  }

  const data = pickSentFields(
    parsed.data as Record<string, unknown>,
    raw,
  ) as Partial<z.infer<T>>
  if (Object.keys(data).length === 0) {
    return { success: false, error: PATCH_AT_LEAST_ONE_FIELD }
  }
  return { success: true, data }
}
