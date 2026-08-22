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
  SUPABASE_TIMEOUT_MS?: string
  REQUEST_TIMEOUT_MS?: string
}

export default {
  fetch(request: Request, env: WorkerBindings): Promise<Response> | Response {
    initEnv(env as unknown as EnvSource)
    return app.fetch(request, env)
  },
}
