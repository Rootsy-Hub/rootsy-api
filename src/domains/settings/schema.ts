import { z } from "zod"

export const SETTINGS_IMAGE_KINDS = [
  "logo",
  "ticket-logo",
  "menu-background",
] as const

export type SettingsImageKind = (typeof SETTINGS_IMAGE_KINDS)[number]

export const updateBusinessBodySchema = z.object({
  name: z.string(),
  phone: z.string().optional().default(""),
  country: z.string().optional().default(""),
  state: z.string().optional().default(""),
  city: z.string().optional().default(""),
  streetAddress: z.string().optional().default(""),
  postalCode: z.string().optional().default(""),
  operationalDayCloseTime: z.string().nullable().optional(),
})

export type UpdateBusinessBody = z.infer<typeof updateBusinessBodySchema>

export const updateFiscalBodySchema = z.object({
  fiscalCuit: z.string().optional().default(""),
  fiscalRazonSocial: z.string().optional().default(""),
  fiscalInicioActividadesDate: z.string().optional().default(""),
  fiscalIngresosBrutosText: z.string().optional().default(""),
  fiscalPadronActividadesJson: z.string().optional().default(""),
  fiscalActividadSeleccionadaId: z.string().optional().default(""),
})

export type UpdateFiscalBody = z.infer<typeof updateFiscalBodySchema>

export const updateImagesBodySchema = z.object({
  imageUrl: z.string().nullable().optional(),
  invoiceLogoUrl: z.string().nullable().optional(),
  backgroundImageUrl: z.string().nullable().optional(),
})

export type UpdateImagesBody = z.infer<typeof updateImagesBodySchema>

export const settingsImageKindSchema = z.enum(SETTINGS_IMAGE_KINDS)

export type PopSettingsForm = {
  name: string
  phone: string
  country: string
  state: string
  city: string
  streetAddress: string
  postalCode: string
  imageUrl: string
  invoiceLogoUrl: string
  backgroundImageUrl: string
  fiscalCuit: string
  fiscalRazonSocial: string
  fiscalInicioActividadesDate: string
  fiscalIngresosBrutosText: string
  fiscalPadronActividadesJson: string
  fiscalActividadSeleccionadaId: string
  fiscalPadronSyncedAt: string | null
  operationalDayCloseTime: string
}

export type PopSettingsData = {
  form: PopSettingsForm
  isOwner: boolean
}
