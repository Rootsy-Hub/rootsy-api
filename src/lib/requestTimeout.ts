import type { MiddlewareHandler } from "hono"

export function requireRequestTimeout(ms: number): MiddlewareHandler {
  return async (c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error("Request timeout")
            err.name = "TimeoutError"
            reject(err)
          }, ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
