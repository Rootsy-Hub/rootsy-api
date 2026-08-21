import { timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getEnv } from "../env.js"
import { userIdFromPayload, verifySupabaseAccessToken } from "./jwt.js"
import { createUserSupabaseClient } from "../lib/supabase.js"

export type PrivateAuthEnv = {
  Variables: {
    accessToken: string
    userId: string
    supabase: SupabaseClient
  }
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token || null
}

export const requirePrivateAuth: MiddlewareHandler<PrivateAuthEnv> = async (
  c,
  next,
) => {
  const env = getEnv()
  const secret = c.req.header("x-rootsy-api-secret")?.trim() ?? ""
  if (!secret || !secretsMatch(secret, env.ROOTSY_API_SECRET)) {
    return c.json({ success: false, error: "Unauthorized" }, 401)
  }

  const token = bearerToken(c.req.header("authorization"))
  if (!token) {
    return c.json({ success: false, error: "Unauthorized" }, 401)
  }

  try {
    const payload = await verifySupabaseAccessToken(token)
    const userId = userIdFromPayload(payload)
    if (!userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401)
    }
    c.set("accessToken", token)
    c.set("userId", userId)
    c.set("supabase", createUserSupabaseClient(token))
    await next()
  } catch {
    return c.json({ success: false, error: "Unauthorized" }, 401)
  }
}
