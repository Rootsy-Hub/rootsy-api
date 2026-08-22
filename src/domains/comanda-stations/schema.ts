import { z } from "zod"

export const createComandaStationBodySchema = z.object({
  name: z.string().trim().min(1, "Indicá el nombre de la estación."),
})

export const updateComandaStationBodySchema = z.object({
  name: z.string().trim().min(1, "Indicá el nombre de la estación."),
})

export type ComandaStationRow = {
  id: string
  name: string
  sortOrder: number
  isActive: boolean
}

export type ComandaStationDetail = ComandaStationRow & {
  categoryCount: number
}
