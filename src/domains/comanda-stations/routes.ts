import { Hono } from "hono"
import { z } from "zod"
import type { SidecarEnv } from "../../sidecar/pop.js"
import { requireAnyPermission } from "../../sidecar/permissions.js"
import { requireMutationPermission } from "../../sidecar/mutationPermission.js"
import {
  STATION_CREATE,
  STATION_DELETE,
  STATION_READ,
  STATION_UPDATE,
} from "./allowlist.js"
import {
  createComandaStation,
  deleteComandaStation,
  getComandaStation,
  listComandaStations,
  updateComandaStation,
} from "./queries.js"
import {
  createComandaStationBodySchema,
  updateComandaStationBodySchema,
} from "./schema.js"

const idSchema = z.string().uuid()

export const comandaStationRoutes = new Hono<SidecarEnv>()

comandaStationRoutes.get("/", requireAnyPermission(STATION_READ), async (c) => {
  const result = await listComandaStations(
    c.get("supabase"),
    c.get("sidecar").popId,
  )
  if (!result.success) return c.json(result, 500)
  return c.json(result)
})

comandaStationRoutes.post(
  "/",
  requireMutationPermission(STATION_CREATE),
  async (c) => {
    const body = createComandaStationBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json(
        {
          success: false,
          error: body.error.issues[0]?.message ?? "Body inválido",
        },
        400,
      )
    }
    const result = await createComandaStation(
      c.get("supabase"),
      c.get("sidecar").popId,
      body.data.name,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status ?? 500)
    return c.json(result, 201)
  },
)

comandaStationRoutes.get(
  "/:stationId",
  requireAnyPermission(STATION_READ),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("stationId"))
    if (!id.success) {
      return c.json({ success: false, error: "stationId inválido" }, 400)
    }
    const result = await getComandaStation(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

comandaStationRoutes.patch(
  "/:stationId",
  requireMutationPermission(STATION_UPDATE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("stationId"))
    if (!id.success) {
      return c.json({ success: false, error: "stationId inválido" }, 400)
    }
    const body = updateComandaStationBodySchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!body.success) {
      return c.json(
        {
          success: false,
          error: body.error.issues[0]?.message ?? "Body inválido",
        },
        400,
      )
    }
    const result = await updateComandaStation(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      body.data.name,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)

comandaStationRoutes.delete(
  "/:stationId",
  requireMutationPermission(STATION_DELETE),
  async (c) => {
    const id = idSchema.safeParse(c.req.param("stationId"))
    if (!id.success) {
      return c.json({ success: false, error: "stationId inválido" }, 400)
    }
    const result = await deleteComandaStation(
      c.get("supabase"),
      c.get("sidecar").popId,
      id.data,
      c.get("mutationAudit"),
    )
    if (!result.success) return c.json(result, result.status)
    return c.json(result)
  },
)
