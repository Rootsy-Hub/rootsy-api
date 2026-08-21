import { z } from "zod"

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  ROOTSY_API_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(8787),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export function getEnv(): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((i) => i.path.join("."))
      .filter(Boolean)
      .join(", ")
    throw new Error(`Env inválida: ${fields || parsed.error.message}`)
  }
  if (!parsed.data.SUPABASE_JWT_SECRET && !parsed.data.SUPABASE_JWKS_URL) {
    parsed.data.SUPABASE_JWKS_URL = `${parsed.data.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`
  }
  cached = parsed.data
  return cached
}
