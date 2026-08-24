import { createApp } from "./app.js"
import { initEnv, type EnvSource } from "./env.js"
import type { RealtimeBindings } from "./realtime/bindings.js"

export { PopRealtime } from "./realtime/PopRealtime.js"

const app = createApp()

export type WorkerBindings = RealtimeBindings & {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_JWT_SECRET?: string
  SUPABASE_JWKS_URL?: string
  ROOTSY_API_SECRET: string
  ROOTSY_AI_EXECUTION_SECRET?: string
  SUPABASE_TIMEOUT_MS?: string
  REQUEST_TIMEOUT_MS?: string
}

export default {
  fetch(request: Request, env: WorkerBindings): Promise<Response> | Response {
    try {
      initEnv(env as unknown as EnvSource)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Env inválida"
      return Response.json({ success: false, error: message }, { status: 500 })
    }
    return app.fetch(request, env)
  },
}
