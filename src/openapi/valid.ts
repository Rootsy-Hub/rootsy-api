import type { Context } from "hono"

export function routeParam(c: Context, name: string): string {
  return c.req.param(name) ?? ""
}

export function routeInput<T>(c: Context, target: "json" | "query"): T {
  return (c.req as unknown as { valid: (key: "json" | "query") => T }).valid(
    target,
  )
}
