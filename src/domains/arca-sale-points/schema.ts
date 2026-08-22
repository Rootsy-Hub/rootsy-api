import { z } from "zod"

export const PTO_VTA_MIN = 1
export const PTO_VTA_MAX = 99999

export const ptoVtaSchema = z
  .number({ error: "Indicá el número de punto de venta." })
  .int("Punto de venta inválido (00001–99999).")
  .min(PTO_VTA_MIN, "Punto de venta inválido (00001–99999).")
  .max(PTO_VTA_MAX, "Punto de venta inválido (00001–99999).")

const expiresAtSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value, ctx) => {
    if (value == null) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Vencimiento inválido.",
      })
      return z.NEVER
    }
    return trimmed
  })

export const createArcaSalePointBodySchema = z.object({
  ptoVta: ptoVtaSchema,
})

export const updateArcaSalePointBodySchema = z
  .object({
    ptoVta: ptoVtaSchema.optional(),
    expiresAt: expiresAtSchema,
    certificatesUploaded: z.boolean().optional(),
    certificateUploaded: z.boolean().optional(),
    keyAndCsrUploaded: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.ptoVta != null ||
      body.expiresAt !== undefined ||
      body.certificatesUploaded === true ||
      body.certificateUploaded === true ||
      body.keyAndCsrUploaded === true,
    { message: "Nada para actualizar" },
  )

export type ArcaSalePointRow = {
  id: string
  ptoVta: number
  expiresAt: string | null
  crtUploadedAt: string | null
  keyUploadedAt: string | null
  csrUploadedAt: string | null
  configured: boolean
  daysUntilExpiry: number | null
}

export type ArcaFiscalConfig = {
  fiscalCuit: string | null
  fiscalRazonSocial: string | null
  salePoints: ArcaSalePointRow[]
  canCreate: boolean
  canUpdate: boolean
}
