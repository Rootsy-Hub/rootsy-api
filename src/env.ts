import { z } from "zod"

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  ROOTSY_API_SECRET: z.string().min(16),
  /** HMAC del runner de Rootsy IA. Distinto de ROOTSY_API_SECRET. */
  ROOTSY_AI_EXECUTION_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(8787),
  /** Tope de cada hop a Supabase (PostgREST / Auth). */
  SUPABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  /** Tope del request HTTP completo. */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
})

export type Env = z.infer<typeof envSchema>

export type EnvSource = Record<string, unknown>

let cached: Env | null = null

function withJwksFallback(data: Env): Env {
  if (!data.SUPABASE_JWT_SECRET && !data.SUPABASE_JWKS_URL) {
    data.SUPABASE_JWKS_URL = `${data.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`
  }
  return data
}

export function parseEnv(source: EnvSource): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((i) => i.path.join("."))
      .filter(Boolean)
      .join(", ")
    throw new Error(`Env inválida: ${fields || parsed.error.message}`)
  }
  return withJwksFallback(parsed.data)
}

export function initEnv(source: EnvSource): Env {
  cached = parseEnv(source)
  return cached
}

export function getEnv(): Env {
  if (cached) return cached
  if (typeof process !== "undefined" && process.env?.SUPABASE_URL) {
    return initEnv(process.env)
  }
  throw new Error("Env no inicializada")
}
