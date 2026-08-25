import type { Context } from "hono"

export function apiFail<S extends 400 | 403 | 404 | 409 | 500>(
  c: Context,
  error: string,
  status: S,
) {
  return c.json({ success: false as const, error }, status)
}
