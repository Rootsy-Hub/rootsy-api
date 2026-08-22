import type { MiddlewareHandler } from "hono"
import { z } from "zod"
import { userIdFromPayload, verifySupabaseAccessToken } from "../auth/jwt.js"
import { createUserSupabaseClient } from "../lib/supabase.js"
import { loadPopSidecar } from "../sidecar/pop.js"
import type { RealtimeBindings } from "./bindings.js"

const popIdSchema = z.string().uuid()

export type RealtimeSession = {
  accessToken: string
  userId: string
  displayName: string
  popId: string
  keys: string[]
  isOwner: boolean
}

export type RealtimeSessionEnv = {
  Bindings: RealtimeBindings
  Variables: {
    realtimeSession: RealtimeSession
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token || null
}

function tokenFromRequest(request: Request, url: URL): string | null {
  const fromHeader = bearerToken(request.headers.get("authorization") ?? undefined)
  if (fromHeader) return fromHeader
  const fromQuery = url.searchParams.get("access_token")?.trim()
  return fromQuery || null
}

function displayNameFromPayload(payload: Record<string, unknown>): string {
  const email = typeof payload.email === "string" ? payload.email.trim() : ""
  if (email.includes("@")) return email.split("@")[0] || email
  if (email) return email
  const sub = typeof payload.sub === "string" ? payload.sub : ""
  return sub || "Usuario"
}

export const requireRealtimeSession: MiddlewareHandler<RealtimeSessionEnv> = async (
  c,
  next,
) => {
  const popParsed = popIdSchema.safeParse(c.req.param("popId"))
  if (!popParsed.success) {
    return c.json({ success: false, error: "popId inválido" }, 400)
  }

  const url = new URL(c.req.url)
  const token = tokenFromRequest(c.req.raw, url)
  if (!token) {
    return c.json({ success: false, error: "Unauthorized: jwt missing" }, 401)
  }

  try {
    const payload = await verifySupabaseAccessToken(token)
    const userId = userIdFromPayload(payload)
    if (!userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401)
    }

    const supabase = createUserSupabaseClient(token)
    const gate = await loadPopSidecar(supabase, userId, popParsed.data)
    if (!gate.ok) {
      return c.json(
        { success: false, error: gate.error, redirect: gate.redirect },
        gate.status,
      )
    }

    c.set("realtimeSession", {
      accessToken: token,
      userId,
      displayName: displayNameFromPayload(payload as Record<string, unknown>),
      popId: gate.sidecar.popId,
      keys: gate.sidecar.keys,
      isOwner: gate.sidecar.isOwner,
    })
    await next()
  } catch {
    return c.json({ success: false, error: "Unauthorized: jwt inválido" }, 401)
  }
}
