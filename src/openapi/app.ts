import { OpenAPIHono } from "@hono/zod-openapi"
import type { Env } from "hono"

export function createOpenApiApp<E extends Env = Env>() {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            success: false,
            error: result.error.issues[0]?.message ?? "Datos inválidos",
          },
          400,
        )
      }
    },
  })
}
