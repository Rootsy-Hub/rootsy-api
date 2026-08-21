import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import { getEnv } from "../env.js"

const JWKS_CACHE = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function issuerFromUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/auth/v1`
}

export async function verifySupabaseAccessToken(
  token: string,
): Promise<JWTPayload> {
  const env = getEnv()
  const issuer = issuerFromUrl(env.SUPABASE_URL)
  const verifyOpts = {
    issuer,
    audience: "authenticated",
  }

  if (env.SUPABASE_JWT_SECRET) {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      verifyOpts,
    )
    return payload
  }

  const jwksUrl = env.SUPABASE_JWKS_URL!
  let jwks = JWKS_CACHE.get(jwksUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl))
    JWKS_CACHE.set(jwksUrl, jwks)
  }
  const { payload } = await jwtVerify(token, jwks, verifyOpts)
  return payload
}

export function userIdFromPayload(payload: JWTPayload): string | null {
  if (typeof payload.sub === "string" && payload.sub.trim()) {
    return payload.sub
  }
  return null
}
